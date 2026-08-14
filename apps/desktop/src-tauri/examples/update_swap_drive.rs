// UP-3b — drive ONE real portable in-place swap, on a real directory, with a
// real binary. Headless, no Tauri.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// `cargo test` proves the rename dance against throwaway directories. It cannot
// prove the part that only exists on a real machine:
//
//   • that a COPY of the shipped binary, started detached with
//     `--flowmic-apply-update`, actually reaches `intercept()` and returns before
//     the instance lock, the window and the sidecar;
//   • that `can_replace_file` really does go from false to true when a running
//     FlowMic lets go of its own image;
//   • that a directory containing ~103 MB of real files is genuinely REPLACED.
//
// Design §4.4 wrote the debt this repays: 「没被真机跑过的回滚等于没有回滚」.
//
// ── SAFETY: WHAT THIS WILL AND WILL NOT TOUCH ───────────────────────────────
//
// 🔴 It operates ONLY on the directory passed as argv[1], and it REFUSES to run
// against the two locations that matter — the owner's live run directory and any
// registered MSI install. The owner's FlowMic is running on this machine right
// now; a driver that could be pointed at it by a slip of the shell is not a test
// tool, it is an accident waiting for a path.
//
//   cargo run --example update_swap_drive -- <install-dir> <archive.zip> <to-version>

use std::path::{Path, PathBuf};

use flowmic_desktop_lib::update::{apply_arg, swap, WINDOWS_PORTABLE_ROOT};

/// Directories this driver refuses to touch, however it is invoked.
///
/// Compared component-wise via the same `starts_with` semantics `Path` provides,
/// not as a substring: a substring test would consider `…\FlowMic-scratch` to be
/// inside `…\FlowMic`.
fn is_protected(dir: &Path) -> Option<String> {
    let live = dirs_local_programs_flowmic();
    if let Some(live) = live {
        if dir == live || dir.starts_with(&live) {
            return Some(format!("{} is the live run directory", dir.display()));
        }
    }
    let s = dir.to_string_lossy().to_ascii_lowercase();
    if s.contains("program files") {
        return Some(format!("{} looks like an MSI install location", dir.display()));
    }
    None
}

fn dirs_local_programs_flowmic() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|l| PathBuf::from(l).join("Programs").join("FlowMic"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: update_swap_drive <install-dir> <archive.zip> <to-version>");
        std::process::exit(2);
    }
    let install = PathBuf::from(&args[0]);
    let archive = PathBuf::from(&args[1]);
    let to = args[2].clone();
    let from = env!("CARGO_PKG_VERSION").to_string();

    if let Some(why) = is_protected(&install) {
        eprintln!("REFUSING: {why}");
        std::process::exit(3);
    }

    let crumbs = flowmic_desktop_lib::app_dirs::local_home();
    println!("── prepare ──");
    println!("install   {}", install.display());
    println!("archive   {}", archive.display());
    println!("crumbs    {}", crumbs.display());

    let prepared = match swap::prepare(&install, &archive, WINDOWS_PORTABLE_ROOT, &from, &to, &crumbs) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("prepare FAILED: {e} (tag={})", e.tag());
            std::process::exit(4);
        }
    };
    println!(
        "extracted {} file(s), {} byte(s) → {}",
        prepared.extracted.files,
        prepared.extracted.bytes,
        prepared.job.staged_root.display(),
    );
    println!("backup    {}", prepared.job.backup_dir.display());

    // The source is the install directory's own executable — i.e. the binary that
    // would be running. Production passes `current_exe()`; here we name it, so the
    // mover really is a copy of the shipped app and not of this driver.
    let source = install.join("FlowMic.exe");
    match apply_arg::spawn_mover(&prepared.job, &source) {
        Ok(pid) => println!("mover pid {pid}"),
        Err(e) => {
            eprintln!("spawn_mover FAILED: {e}");
            std::process::exit(5);
        }
    }
}
