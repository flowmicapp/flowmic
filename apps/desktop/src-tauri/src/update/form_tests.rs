// Tests for `form.rs` — which shape is this running copy.
//
// The paths below are FABRICATED on purpose (that is what taking a `&Path`
// argument buys), but the two exe NAMES they are built from are pinned to their
// real producers by the last two tests in this file. A suite that invented both
// the paths and the names would be asking itself questions it had also written
// the answers to.

use super::*;

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
}

/// The MSI install location as this machine actually records it
/// [measured 2026-08-08, dev-pc-a]: registry `InstallLocation` =
/// `C:\Program Files\FlowMic\`, holding `flowmic-desktop.exe` at 0.1.5.
#[cfg(windows)]
fn msi_dirs() -> Vec<PathBuf> {
    vec![p(r"C:\Program Files\FlowMic")]
}

/// 🔴 Dev detection runs BEFORE the platform gate and before any filename test,
/// so it is asserted on every platform. A dev build is named exactly what the
/// MSI's binary is named — the ordering in `classify_exe_path` is the only thing
/// stopping `target\release\flowmic-desktop.exe` from being treated as an
/// installed copy and offered an msiexec run over somebody's working tree.
///
/// Paths are built with `PathBuf::join` (THIS host's separator) rather than a
/// machine-specific absolute string: a Windows-spelled `F:\…\target\release\…`
/// is one Normal component on POSIX, so `is_dev_path` correctly misses it and
/// the platform gate answers `UnsupportedPlatform` — which is the right product
/// answer for a foreign `.exe`, not a reason to skip the assertion.
#[test]
fn a_build_tree_or_the_artifact_area_is_never_offered_an_update() {
    // Component-wise shapes that Path recognises on every host.
    let always_dev: [PathBuf; 5] = [
        PathBuf::from("apps")
            .join("desktop")
            .join("src-tauri")
            .join("target")
            .join("release")
            .join("flowmic-desktop.exe"),
        PathBuf::from("apps")
            .join("desktop")
            .join("src-tauri")
            .join("target")
            .join("debug")
            .join("flowmic-desktop.exe"),
        // RV-73: the artifact area. Running from it is already forbidden.
        PathBuf::from("publish")
            .join("FlowMic-0.2.59-portable")
            .join("FlowMic.exe"),
        // Same shapes with `/` separators — a substring search for
        // `target\release` would match nothing on a `/`-separated path.
        p("/home/dev/flowmic-app/apps/desktop/src-tauri/target/release/flowmic-desktop"),
        p("/home/dev/flowmic-app/publish/FlowMic-portable/FlowMic"),
    ];
    for path in &always_dev {
        let form = classify_exe_path(path, &[]);
        assert_eq!(
            form,
            InstallForm::Dev,
            "{} must classify as Dev",
            path.display()
        );
        assert!(
            !form.should_check(),
            "{} must not even contact the endpoint",
            path.display()
        );
    }

    // A Windows-backslash spelling. On Windows Path splits it (many components,
    // Dev wins); on POSIX `\` is literal so the whole string is one Normal
    // component — not a build tree — and a non-Windows host correctly answers
    // UnsupportedPlatform for that `.exe`.
    let win_spelled =
        r"F:\dev\flowmic-app\apps\desktop\src-tauri\target\release\flowmic-desktop.exe";
    let win_form = classify_exe_path(&p(win_spelled), &[]);
    let backslash_is_separator = Path::new(win_spelled).components().count() > 1;
    if backslash_is_separator {
        assert_eq!(
            win_form,
            InstallForm::Dev,
            "{win_spelled} must classify as Dev when Path splits on `\\`"
        );
    } else {
        assert_eq!(
            win_form,
            InstallForm::UnsupportedPlatform,
            "{win_spelled} is one Normal component on this host; the product \
             answer is UnsupportedPlatform, not a silent Dev via substring"
        );
    }

    // …and the ONLY form that skips the check is Dev.
    for other in [
        InstallForm::Portable,
        InstallForm::Unknown,
        InstallForm::UnsupportedPlatform,
        InstallForm::MsiInstalled { install_dir: p(r"C:\Program Files\FlowMic") },
    ] {
        assert!(other.should_check(), "{} must still check", other.tag());
    }
}

/// 🔴 The boundary cases that a naive check gets wrong. Each of these is a real
/// shape somebody's disk can be in, and each would be misread by the obvious
/// implementation (substring search).
#[test]
fn near_misses_are_not_dev_paths() {
    for path in [
        // `publisher`, not `publish` — a substring search matches this.
        r"C:\Users\publisher\FlowMic\FlowMic.exe",
        // A user folder that merely contains the word.
        r"C:\Users\bob\publishing\FlowMic\FlowMic.exe",
        // `release` WITHOUT `target` before it: a perfectly ordinary place to
        // unpack a portable bundle.
        r"D:\downloads\release\FlowMic.exe",
        // `target` without debug/release after it.
        r"D:\target\FlowMic.exe",
    ] {
        assert_ne!(
            classify_exe_path(&p(path), &[]),
            InstallForm::Dev,
            "{path} is not a build tree — treating it as one silently disables updates",
        );
    }
}

#[cfg(windows)]
#[test]
fn an_installed_copy_is_recognised_only_when_the_registry_corroborates_it() {
    let installed = p(r"C:\Program Files\FlowMic\flowmic-desktop.exe");

    assert_eq!(
        classify_exe_path(&installed, &msi_dirs()),
        InstallForm::MsiInstalled { install_dir: p(r"C:\Program Files\FlowMic") },
    );

    // Windows paths are case-insensitive. A case-sensitive compare here would
    // silently demote a real install to `Unknown` — the failure mode with no
    // symptom, since `Unknown` behaves like `Portable` and nobody would notice
    // that the install chain had switched itself off.
    assert_eq!(
        classify_exe_path(&p(r"C:\PROGRAM FILES\FLOWMIC\FLOWMIC-DESKTOP.EXE"), &msi_dirs()),
        InstallForm::MsiInstalled { install_dir: p(r"C:\Program Files\FlowMic") },
    );

    // 🔴 No registration ⇒ `Unknown`, NOT `MsiInstalled`. This is the
    // `msiexec /a` extraction case, which this repo has genuinely performed.
    // Guessing `MsiInstalled` would launch an installer against a machine where
    // the product is not registered.
    assert_eq!(
        classify_exe_path(&p(r"D:\extracted\flowmic-desktop.exe"), &[]),
        InstallForm::Unknown,
    );
    assert_eq!(classify_exe_path(&installed, &[]), InstallForm::Unknown);

    // 🔴 Prefix-without-a-boundary. `C:\Program Files\FlowMic-old` starts with
    // the install dir as a STRING but is a different directory. Component-wise
    // comparison is what makes this `Unknown` instead of `MsiInstalled`.
    assert_eq!(
        classify_exe_path(&p(r"C:\Program Files\FlowMic-old\flowmic-desktop.exe"), &msi_dirs()),
        InstallForm::Unknown,
    );

    // A deeper path inside the install dir still counts as inside it.
    assert_eq!(
        classify_exe_path(&p(r"C:\Program Files\FlowMic\bin\flowmic-desktop.exe"), &msi_dirs()),
        InstallForm::MsiInstalled { install_dir: p(r"C:\Program Files\FlowMic") },
    );
}

#[cfg(windows)]
#[test]
fn the_portable_bundle_is_recognised_by_the_name_publish_gives_it() {
    // [measured 2026-08-08, dev-pc-a] this is the process running right now.
    let running = p(r"C:\Users\builder\AppData\Local\Programs\FlowMic\FlowMic.exe");
    assert_eq!(classify_exe_path(&running, &msi_dirs()), InstallForm::Portable);

    // 🔴 Note WHICH directory that is. `install-local.mjs` puts the run copy in
    // `%LOCALAPPDATA%\Programs\FlowMic\`, deliberately NOT `%LOCALAPPDATA%\FlowMic\`
    // (which holds logs and credentials — and, as of this card, the `updates\`
    // download directory). So a downloaded installer never lands inside the
    // directory a future in-place swap would be replacing. Asserted rather than
    // trusted, because the two paths differ by one segment.
    let downloads_root = p(r"C:\Users\builder\AppData\Local\FlowMic");
    assert!(
        !is_under(&downloads_root, &running),
        "the run directory must not sit under the app-data directory we download into",
    );

    // Copied anywhere at all: still portable.
    for path in [r"D:\FlowMic\FlowMic.exe", r"C:\Users\bob\Desktop\FlowMic\FlowMic.exe"] {
        assert_eq!(classify_exe_path(&p(path), &msi_dirs()), InstallForm::Portable);
    }

    // A name we do not produce is `Unknown` — never guessed into a form.
    for path in [r"D:\FlowMic\flowmic.exe.bak", r"D:\FlowMic\updater.exe"] {
        assert_eq!(classify_exe_path(&p(path), &msi_dirs()), InstallForm::Unknown);
    }
}

#[cfg(not(windows))]
#[test]
fn a_platform_with_no_update_chain_says_so_rather_than_guessing() {
    // Design §6: macOS needs its own chain. Saying `Unknown` there would be a
    // lie — we can see exactly what we are, we just have nowhere to take it.
    assert_eq!(
        classify_exe_path(&p("/Applications/FlowMic.app/Contents/MacOS/flowmic-desktop"), &[]),
        InstallForm::UnsupportedPlatform,
    );
    // …but a dev tree is still a dev tree, and still checks nothing.
    assert_eq!(
        classify_exe_path(&p("/w/flowmic-app/apps/desktop/src-tauri/target/debug/flowmic-desktop"), &[]),
        InstallForm::Dev,
    );
}

/// Every form has a distinct tag — they are UP-3b's string-table keys, so two
/// forms sharing one would merge two sentences into one.
#[test]
fn every_form_has_its_own_tag() {
    let forms = [
        InstallForm::Dev,
        InstallForm::MsiInstalled { install_dir: p("x") },
        InstallForm::Portable,
        InstallForm::Unknown,
        InstallForm::UnsupportedPlatform,
    ];
    let mut tags: Vec<&str> = forms.iter().map(|f| f.tag()).collect();
    let n = tags.len();
    tags.sort_unstable();
    tags.dedup();
    assert_eq!(tags.len(), n, "two InstallForm variants share a tag");
}

/// 🔴 The name the MSI installs is decided by Cargo's package name, not by this
/// constant. A package rename would leave this string matching nothing, every
/// MSI install would classify as `Unknown`, and the install chain would switch
/// itself off with no gate going red. Pinned mechanically instead of promised in
/// a comment.
#[test]
fn the_msi_exe_name_matches_the_cargo_target_that_produces_it() {
    let stem = MSI_EXE_NAME.strip_suffix(".exe").unwrap_or(MSI_EXE_NAME);
    assert_eq!(
        stem,
        env!("CARGO_PKG_NAME"),
        "the MSI installs the Cargo binary; if the package is renamed, this constant \
         must move with it or every installed copy silently becomes `Unknown`",
    );
}

/// 🔴 The portable name exists ONLY because one line of `scripts/publish.mjs`
/// renames the binary on its way into the bundle. Rust cannot import that file,
/// so it is read as DATA and asserted against — the same technique
/// `node_runtime.rs::the_bundled_runtime_name_matches_the_pin_declaration` uses
/// for `bundled-node.mjs`. A comment saying「两边保持一致」("the two sides
/// stay in sync") would be an anti-façade ④
/// claim about somebody else's file, and it would stay green forever after that
/// file changed.
#[test]
fn the_portable_exe_name_matches_what_publish_mjs_stages() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("scripts")
        .join("publish.mjs");
    let text = std::fs::read_to_string(&script)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", script.display()));

    // The staging call: `stage(exePath, PORTABLE, 'FlowMic.exe')`.
    let staged = text
        .split("stage(exePath, PORTABLE,")
        .nth(1)
        .and_then(|s| s.split('\'').nth(1))
        .unwrap_or_else(|| {
            panic!(
                "could not find the portable exe staging call in {}. It may have been \
                 refactored — if so, re-derive PORTABLE_EXE_NAME from wherever the name \
                 is now decided rather than deleting this test: the constant it guards \
                 is the ONLY thing that tells a portable copy from an installed one",
                script.display(),
            )
        });
    assert_eq!(
        staged, PORTABLE_EXE_NAME,
        "publish.mjs stages the portable exe as `{staged}` but this crate looks for \
         `{PORTABLE_EXE_NAME}` — every portable copy would classify as `Unknown`",
    );
}

/// The `r+`-shaped question: 「can I replace this file」, not 「did the process
/// exit」.
#[test]
fn replaceability_is_asked_of_the_file_not_of_a_process() {
    let dir = std::env::temp_dir().join(format!("fm-update-form-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // A file that does not exist is not replaceable — you would be creating it.
    let missing = dir.join("nope.exe");
    assert!(!can_replace_file(&missing));

    // An ordinary file is.
    let ordinary = dir.join("ordinary.exe");
    std::fs::write(&ordinary, b"payload").unwrap();
    assert!(can_replace_file(&ordinary));

    // 🔴 And the probe must not have DAMAGED it. `write(true)` without
    // `truncate(true)` leaves the bytes alone; a "tidy-up" to `File::create`
    // would empty the binary this function exists to protect.
    assert_eq!(std::fs::read(&ordinary).unwrap(), b"payload");

    // A directory is not a replaceable file.
    assert!(!can_replace_file(&dir));

    let _ = std::fs::remove_dir_all(&dir);
}
