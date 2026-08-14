// Tests for `archive.rs` — the「是不是我以为的那个形状」("is this the shape I
// think it is") gate.
//
// 🔴 THE ROOT NAMES BELOW ARE LITERALS, ON PURPOSE.
//
// The release-chain lane found the trap: asserting `top_level == SOME_CONSTANT`
// is self-referential — move the constant and both sides move together, the test
// stays green, and the shipped package changes under every consumer's feet.
//
// > An assertion has to be expensive enough that breaking it costs something.
// > A test that moves whenever the thing it guards moves is not a guard.
//
// So `"FlowMic-portable"` and `"FlowMic.app"` are spelled out here. If the
// release chain renames either, this file goes red and somebody has to look at
// the update path — which is the entire point.

use super::*;
use crate::portable::zip::{crc32, ZipWriter};

/// The Windows portable bundle's top-level directory [measured 2026-08-08].
const WINDOWS_ROOT: &str = "FlowMic-portable";
/// The macOS bundle's top-level entry [measured 2026-08-08]. 🔴 A DIFFERENT NAME
/// for the same `kind` — this is why `verify_root` takes the expectation as an
/// argument instead of holding a constant.
const MACOS_ROOT: &str = "FlowMic.app";

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("fm-update-arc-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Build a STORE zip holding exactly the given entry names.
fn make_zip(path: &std::path::Path, names: &[&str]) {
    let mut w = ZipWriter::create(path).unwrap();
    for name in names {
        let body = b"payload";
        w.begin(name, body.len() as u64, crc32(body), 0).unwrap();
        w.body(body).unwrap();
        w.end().unwrap();
    }
    w.finish().unwrap();
}

/// 🔴 THE CASE THAT MATTERS: both shapes we ship today, through one function,
/// each verified against its OWN expectation. A implementation that hard-coded
/// either root would fail the other — which is precisely the defect that would
/// have shipped on macOS on day one.
#[test]
fn both_portable_shapes_we_ship_verify_against_their_own_expectation() {
    let dir = tmpdir("both");

    let win = dir.join("FlowMic-0.2.60-portable-windows-x64.zip");
    make_zip(&win, &[
        "FlowMic-portable/FlowMic.exe",
        "FlowMic-portable/node.exe",
        "FlowMic-portable/NOTICE",
        "FlowMic-portable/resources/server.js",
        "FlowMic-portable/使用说明.txt",
    ]);
    let shape = verify_root(&win, WINDOWS_ROOT).expect("the Windows bundle must verify");
    assert_eq!(shape.roots, vec![WINDOWS_ROOT.to_string()]);
    assert_eq!(shape.entries, 5);

    let mac = dir.join("FlowMic-0.2.60-macos-arm64.zip");
    make_zip(&mac, &[
        "FlowMic.app/Contents/MacOS/flowmic-desktop",
        "FlowMic.app/Contents/Resources/resources/node",
        "FlowMic.app/Contents/Info.plist",
    ]);
    let shape = verify_root(&mac, MACOS_ROOT).expect("the macOS bundle must verify");
    assert_eq!(shape.roots, vec![MACOS_ROOT.to_string()]);

    // 🔴 And the cross-check, which is the assertion with teeth: each archive
    // is REFUSED against the other's expectation. If `verify_root` ignored its
    // argument — the most likely way for this to rot — both of these would pass.
    let err = verify_root(&win, MACOS_ROOT).unwrap_err();
    assert_eq!(
        err,
        UpdateFailure::ArchiveLayoutUnexpected {
            expected: MACOS_ROOT.to_string(),
            found: vec![WINDOWS_ROOT.to_string()],
        },
    );
    assert!(verify_root(&mac, WINDOWS_ROOT).is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

/// An archive that would scatter files into the parent directory. Extracting one
/// of these over a run directory is how an "update" leaves a folder full of
/// loose files next to the app.
#[test]
fn an_archive_with_more_than_one_root_is_refused_and_names_them_all() {
    let dir = tmpdir("multi");
    let z = dir.join("multi.zip");
    make_zip(&z, &["FlowMic-portable/FlowMic.exe", "README.txt", "extras/other.dll"]);

    let err = verify_root(&z, WINDOWS_ROOT).unwrap_err();
    match err {
        UpdateFailure::ArchiveLayoutUnexpected { expected, found } => {
            assert_eq!(expected, WINDOWS_ROOT);
            // Sorted, and ALL of them — a diagnostic naming only the first
            // would send somebody looking for one stray file when there are two.
            assert_eq!(found, vec!["FlowMic-portable".to_string(), "README.txt".to_string(), "extras".to_string()]);
        }
        other => panic!("expected ArchiveLayoutUnexpected, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Not a zip at all — e.g. an HTML error page a proxy served with a 200, which
/// would have passed the hash gate only if the manifest itself were wrong, but
/// is exactly what a hand-edited local file can be.
#[test]
fn a_file_that_is_not_a_zip_says_so() {
    let dir = tmpdir("notzip");
    let z = dir.join("nope.zip");
    std::fs::write(&z, b"<!doctype html><html>not a zip</html>").unwrap();
    assert_eq!(
        verify_root(&z, WINDOWS_ROOT).unwrap_err(),
        UpdateFailure::ArchiveUnreadable { detail: "not_a_zip".to_string() },
    );

    // A path that does not exist is an IO failure, not a layout opinion.
    assert_eq!(
        verify_root(&dir.join("absent.zip"), WINDOWS_ROOT).unwrap_err(),
        UpdateFailure::ArchiveUnreadable { detail: "io".to_string() },
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// An empty archive has no roots. It must not read as「fine, nothing to check」.
#[test]
fn an_empty_archive_is_refused_rather_than_waved_through() {
    let dir = tmpdir("empty");
    let z = dir.join("empty.zip");
    make_zip(&z, &[]);
    let err = verify_root(&z, WINDOWS_ROOT).unwrap_err();
    assert_eq!(
        err,
        UpdateFailure::ArchiveLayoutUnexpected {
            expected: WINDOWS_ROOT.to_string(),
            found: vec![],
        },
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The failure vocabulary here obeys the same rule as the rest of the taxonomy:
/// a diagnostic must not be renderable as「已是最新」("already up to date") and must not leak a path.
#[test]
fn the_archive_failures_carry_no_reassurance_and_no_path() {
    let cases = [
        UpdateFailure::ArchiveUnreadable { detail: "not_a_zip".into() },
        UpdateFailure::ArchiveLayoutUnexpected {
            expected: WINDOWS_ROOT.into(),
            found: vec![MACOS_ROOT.into()],
        },
        UpdateFailure::ArchiveUnsafeEntry { names: vec!["../evil".into()] },
    ];
    for f in cases {
        let s = f.to_string();
        assert!(!s.is_empty());
        assert!(!s.to_ascii_lowercase().contains("latest"));
        assert!(!s.contains("已是最新"));
        assert!(!s.contains("C:\\"));
        assert!(!s.contains("http"));
        // An archive we refused must be dismissed by hand, exactly like a hash
        // mismatch: both mean「我们拒绝把这个文件交出去」("we refuse to hand
        // over this file").
        assert!(f.is_blocking(), "{} must block", f.tag());
    }
}
