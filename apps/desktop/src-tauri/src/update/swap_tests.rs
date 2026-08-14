// Tests for `swap.rs` — the portable in-place upgrade.
//
// 🔴 The two that matter are NOT the happy path:
//
//   • `the_preflight_refuses_before_anything_that_leads_to_an_exit` — reverse
//     control (a). Deleting the preflight call makes it red.
//   • `a_failure_after_the_first_rename_puts_the_old_tree_back` — reverse
//     control (b). Breaking the rollback makes it red.
//
// Design §4.4 said it in as many words about this exact code:
//   「我们自己写的搬运工，回滚也得我们自己写 —— 而**没被真机跑过的回滚等于没有
//    回滚**。」("If we write our own mover, we have to write our own rollback
//    too — and **a rollback that has never run on a real machine is the same
//    as having no rollback**.")
// A rollback whose only evidence is that it compiles does not exist. These tests
// are the unit half of that debt; the real-machine half is in the card's report.

use super::*;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fm-update-swap-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Write a file and every directory above it.
fn put(root: &Path, rel: &str, body: &[u8]) {
    let p = rel.split('/').fold(root.to_path_buf(), |a, s| a.join(s));
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

/// Every file under `root`, as relative-path → bytes.
///
/// 🔴 The whole tree, with CONTENT — not a file count and not `exists()`. The
/// claim under test is「this directory was replaced by that one」, and a count
/// would be equally happy if the two trees had the same shape and different
/// bytes, which is the exact failure a swap can produce.
fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if let Ok(bytes) = std::fs::read(&p) {
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(rel, bytes);
            }
        }
    }
    walk(root, root, &mut out);
    out
}

/// A minimal but COMPLETE portable tree, so `sanity_check_staged` passes.
fn make_tree(root: &Path, marker: &str) {
    put(root, "FlowMic.exe", format!("exe-{marker}").as_bytes());
    put(root, "node.exe", format!("node-{marker}").as_bytes());
    put(root, "resources/server.js", format!("server-{marker}").as_bytes());
    put(root, "resources/package.json", br#"{"type":"module"}"#);
    // ENG-1 / fix-028 — the sherpa addon is part of a complete portable copy.
    put(
        root,
        "resources/node_modules/sherpa-onnx-node/package.json",
        format!("glue-{marker}").as_bytes(),
    );
    put(
        root,
        "resources/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node",
        format!("addon-{marker}").as_bytes(),
    );
}

// ── preflight ───────────────────────────────────────────────────────────────

#[test]
fn preflight_passes_where_a_sibling_can_be_made_and_renamed() {
    let base = tmp("pf-ok");
    let install = base.join("FlowMic");
    std::fs::create_dir_all(&install).unwrap();
    assert!(preflight(&install).is_ok());
    // …and it cleans up after itself: a probe left behind every check would
    // slowly fill the parent with empty directories.
    let leftovers: Vec<_> = std::fs::read_dir(&base)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".flowmic-preflight"))
        .collect();
    assert!(leftovers.is_empty(), "preflight left {} probe(s) behind", leftovers.len());
}

#[test]
fn preflight_refuses_a_location_that_is_not_there() {
    let base = tmp("pf-missing");
    let err = preflight(&base.join("gone")).unwrap_err();
    assert_eq!(err.tag(), "location_not_updatable");
    assert!(err.is_blocking(), "the user must read this one — it will not fix itself");
}

// ── the staged-tree sanity check ────────────────────────────────────────────

#[test]
fn a_staged_tree_missing_a_required_file_is_refused_by_name() {
    let base = tmp("sanity");
    let root = base.join("FlowMic-portable");
    make_tree(&root, "new");
    assert!(sanity_check_staged(&root).is_ok());

    std::fs::remove_file(root.join("node.exe")).unwrap();
    let err = sanity_check_staged(&root).unwrap_err();
    assert_eq!(err.tag(), "staged_tree_incomplete");
    assert!(err.to_string().contains("node.exe"), "the diagnostic must name what is missing");
}

/// 🔴 A zero-byte file passes `exists()` and fails to run.
///
/// This is the difference between asking「is there a file called FlowMic.exe」
/// and「is there a FlowMic」. A truncated write — disk full at 99%, an antivirus
/// scanner removing content — produces exactly this, and a presence check would
/// hand it to the mover and delete the user's working copy for it.
#[test]
fn a_zero_byte_required_file_counts_as_missing() {
    let base = tmp("sanity-zero");
    let root = base.join("FlowMic-portable");
    make_tree(&root, "new");
    std::fs::write(root.join("FlowMic.exe"), b"").unwrap();
    let err = sanity_check_staged(&root).unwrap_err();
    assert_eq!(err.tag(), "staged_tree_incomplete");
    assert!(err.to_string().contains("FlowMic.exe"));
}

/// 🔴 Our idea of「a complete portable copy」must be the SAME as the one
/// `scripts/install-local.mjs` has been enforcing for several versions.
///
/// Read as DATA, not asserted in a comment — the technique
/// `form_tests.rs::the_portable_exe_name_matches_what_publish_mjs_stages` uses
/// against `publish.mjs`. Two quietly diverging answers to「what files does
/// FlowMic need」 is this repo's headline bug shape, and the divergence would only
/// ever be discovered by shipping a swap that produced a broken install.
#[test]
fn the_required_file_list_matches_install_local_mjs() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("scripts")
        .join("install-local.mjs");
    let text = std::fs::read_to_string(&script)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", script.display()));

    let block = text
        .split("const REQUIRED_FILES = [")
        .nth(1)
        .and_then(|s| s.split(']').next())
        .unwrap_or_else(|| {
            panic!(
                "could not find REQUIRED_FILES in {}. If it moved, re-derive this list from \
                 wherever the answer now lives rather than deleting the test: it is the only \
                 thing keeping two definitions of「a complete portable copy」in step",
                script.display(),
            )
        });
    // The script builds paths with `join('resources', 'server.js')`, so collect
    // the quoted fragments and rebuild them the way it does.
    // Comments are stripped FIRST: an apostrophe or a quoted module name inside
    // a `//` comment is prose, not a path, and the ENG-1 entries arrived with
    // exactly such a comment (same false-positive shape as ADM-P0-1).
    let mut theirs: Vec<String> = Vec::new();
    for line in block.lines() {
        let line = line.split("//").next().unwrap_or(line);
        let quoted: Vec<&str> = line.split('\'').skip(1).step_by(2).collect();
        if quoted.is_empty() {
            continue;
        }
        theirs.push(quoted.join("/"));
    }
    theirs.sort();
    let mut ours: Vec<String> = REQUIRED_STAGED_FILES.iter().map(|s| (*s).to_string()).collect();
    ours.sort();
    assert_eq!(
        ours, theirs,
        "install-local.mjs and swap.rs disagree about what a complete portable copy is",
    );
}

// ── the rename dance ────────────────────────────────────────────────────────

/// Build an install dir + a staged tree and return a job wiring them together.
fn scenario(tag: &str) -> (PathBuf, SwapJob) {
    let base = tmp(tag);
    let install = base.join("FlowMic");
    make_tree(&install, "old");
    let job = plan(&install, "0.2.60", "0.2.59", "FlowMic-portable").unwrap();
    make_tree(&job.staged_root, "new");
    (install, job)
}

#[test]
fn the_happy_path_really_replaces_the_directory() {
    let (install, job) = scenario("swap-ok");
    let before = snapshot(&install);
    assert_eq!(before.len(), 6);
    assert_eq!(before["FlowMic.exe"], b"exe-old");

    assert_eq!(apply_swap(&job), SwapOutcome::Swapped);

    let after = snapshot(&install);
    assert_eq!(after.len(), 6, "the new tree must have the same six files");
    // 🔴 Both directions. Asserting only that the new bytes are present would
    // stay green if the swap had MERGED the two trees rather than replaced one.
    assert_eq!(after["FlowMic.exe"], b"exe-new");
    assert_eq!(after["node.exe"], b"node-new");
    assert_eq!(after["resources/server.js"], b"server-new");
    assert!(after.values().all(|v| !v.ends_with(b"-old")), "no byte of the old tree may survive");
    // The old tree is parked, not destroyed: `apply_swap` never deletes.
    assert_eq!(snapshot(&job.backup_dir)["FlowMic.exe"], b"exe-old");
}

/// 🔴 REVERSE CONTROL (b) — a failure after the first rename must put the old
/// tree back.
///
/// The failure is injected by REALITY, not by a test hook: `staged_root` is
/// removed, so `rename(staged → install)` fails the way it would on a disk error
/// or a foreign handle. That matters — a boolean `fail_here` parameter would be
/// testing a branch that production never takes.
///
/// **How to watch it go red**: in `apply_swap`, replace the rollback `match` with
/// a bare `SwapOutcome::Failed { … rolled_back: false }`. The install directory
/// then does not exist and this test fails on the very first assertion.
#[test]
fn a_failure_after_the_first_rename_puts_the_old_tree_back() {
    let (install, job) = scenario("swap-rollback");
    let before = snapshot(&install);
    // Make step ② fail: there is nothing to rename into place.
    std::fs::remove_dir_all(&job.staging_dir).unwrap();

    let outcome = apply_swap(&job);
    match outcome {
        SwapOutcome::Failed { rolled_back, ref detail } => {
            assert!(rolled_back, "the old tree must be restored; detail was {detail}");
            assert!(!detail.starts_with("rollback_failed"), "detail was {detail}");
        }
        SwapOutcome::Swapped => panic!("a swap with no staged tree must not report success"),
    }

    // 🔴 The assertion that costs something: byte-for-byte, both directions.
    assert!(install.is_dir(), "the install directory must exist again");
    let after = snapshot(&install);
    assert_eq!(after, before, "the install directory must be exactly what it was");
    assert_eq!(after.len(), 6);
    assert_eq!(after["FlowMic.exe"], b"exe-old");
    // …and nothing is left parked under the backup name, because it moved back.
    assert!(!job.backup_dir.exists(), "the backup must not still be there after a rollback");
}

/// The other half of the same question: when the FIRST rename fails, nothing has
/// moved at all, and the outcome must say so rather than claiming a rollback it
/// never performed.
#[test]
fn a_failure_before_the_first_rename_reports_that_nothing_moved() {
    let base = tmp("swap-nomove");
    let install = base.join("does-not-exist");
    let job = plan(&install, "0.2.60", "0.2.59", "FlowMic-portable").unwrap();

    match apply_swap(&job) {
        SwapOutcome::Failed { rolled_back, detail } => {
            assert!(!rolled_back);
            // 🔴 `rolled_back: false` alone would be ambiguous between「nothing
            // moved」and「the rollback failed」— two very different nights for a
            // user. The detail is what separates them.
            assert!(detail.starts_with("nothing_moved:"), "detail was {detail}");
        }
        SwapOutcome::Swapped => panic!("there was nothing to swap"),
    }
}

// ── prepare(): the order of the checks ──────────────────────────────────────

/// 🔴 REVERSE CONTROL (a) — the preflight must refuse BEFORE anything that leads
/// to an exit.
///
/// The scenario is real, not contrived: the portable folder was moved or deleted
/// while the app was running. With the preflight, `prepare` refuses and the disk
/// is untouched. Without it, the archive is unpacked (~103 MB in production) and
/// a breadcrumb is written announcing an update attempt — and the failure is then
/// discovered by the MOVER, which runs after the app has exited and after the
/// user has been told to expect a restart.
///
/// **How to watch it go red**: delete the `preflight(install_dir)?;` line at the
/// top of `prepare`. Both the staging assertion and the breadcrumb assertion
/// fail — the error also changes from `location_not_updatable` to a downstream
/// one, which is precisely the point: the wrong layer answers.
#[test]
fn the_preflight_refuses_before_anything_that_leads_to_an_exit() {
    let base = tmp("prepare-refuse");
    let install = base.join("FlowMic"); // deliberately NOT created
    let crumbs = base.join("crumbs");
    // A real archive is not needed: the preflight must fire before the archive is
    // even opened, and passing a path that does not exist proves that too.
    let archive = base.join("nope.zip");

    let err = prepare(&install, &archive, "FlowMic-portable", "0.2.59", "0.2.60", &crumbs)
        .expect_err("a missing install directory cannot be updated in place");
    assert_eq!(
        err.tag(),
        "location_not_updatable",
        "the refusal must come from the preflight, not from a later layer",
    );

    // 🔴 The assertions that make this a reverse control rather than a smoke test.
    let staged: Vec<_> = std::fs::read_dir(&base)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".flowmic-update-"))
        .collect();
    assert!(staged.is_empty(), "nothing may be extracted before the location is known good");
    assert!(
        super::super::breadcrumb::read_in(&crumbs).is_none(),
        "no breadcrumb may exist: it announces an attempt we have not committed to",
    );
}

/// The breadcrumb is written LAST, and only when everything before it passed.
#[test]
fn prepare_writes_the_breadcrumb_only_after_the_tree_checks_out() {
    let base = tmp("prepare-order");
    let install = base.join("FlowMic");
    make_tree(&install, "old");
    let crumbs = base.join("crumbs");
    // An archive that is not a zip: `verify_root` refuses at step 2.
    let archive = base.join("bad.zip");
    std::fs::write(&archive, b"not a zip at all").unwrap();

    let err = prepare(&install, &archive, "FlowMic-portable", "0.2.59", "0.2.60", &crumbs)
        .expect_err("a non-zip must be refused");
    assert_eq!(err.tag(), "archive_unreadable");
    assert!(
        super::super::breadcrumb::read_in(&crumbs).is_none(),
        "a refused archive must not leave an attempt on the record",
    );
}

// ── waiting ─────────────────────────────────────────────────────────────────

/// The predicate is injected so the timeout is testable in milliseconds instead
/// of the 90 real seconds production waits.
#[test]
fn the_wait_returns_as_soon_as_the_predicate_is_satisfied() {
    let mut calls = 0;
    let ok = wait_until(
        || {
            calls += 1;
            calls >= 3
        },
        Duration::from_secs(5),
        Duration::from_millis(1),
    );
    assert!(ok);
    assert_eq!(calls, 3);
}

#[test]
fn the_wait_gives_up_and_says_so() {
    let ok = wait_until(|| false, Duration::from_millis(5), Duration::from_millis(1));
    assert!(!ok, "a wait that never succeeds must report failure, not loop forever");
}

/// 🔴 The predicate is asked at least once even when the timeout is zero.
///
/// The natural loop shape (`while !timed_out { check }`) skips the check
/// entirely for a zero timeout and reports failure for a file that was free the
/// whole time.
#[test]
fn the_wait_asks_at_least_once_even_with_no_time_at_all() {
    let mut asked = 0;
    let ok = wait_until(
        || {
            asked += 1;
            true
        },
        Duration::ZERO,
        Duration::from_millis(1),
    );
    assert!(ok);
    assert_eq!(asked, 1);
}

/// The paths of one attempt are all siblings of the install directory.
///
/// Not cosmetic: a staging directory on another volume turns the rename into a
/// copy of ~103 MB, which is a different operation with different failure modes
/// (partial copy, disk full at 90%) and no atomicity.
#[test]
fn every_path_in_a_job_is_a_sibling_of_the_install_directory() {
    let base = tmp("siblings");
    let install = base.join("FlowMic");
    std::fs::create_dir_all(&install).unwrap();
    let job = plan(&install, "0.2.60", "0.2.59", "FlowMic-portable").unwrap();
    let parent = install.parent().unwrap();
    assert_eq!(job.staging_dir.parent().unwrap(), parent);
    assert_eq!(job.backup_dir.parent().unwrap(), parent);
    assert_eq!(job.staged_root.parent().unwrap(), job.staging_dir);
    // The mover waits on, and relaunches, the portable executable by its own name.
    assert_eq!(job.wait_exe, install.join("FlowMic.exe"));
    assert_eq!(job.relaunch_exe, install.join("FlowMic.exe"));
}
