// Tests for `download.rs` — gate ③, the only one of the three hash gates that
// protects a user.
//
// Everything here drives `finalize` and `sha256_file` against files written by
// hand. That is deliberate: the transport is a `reqwest` call with no branches
// worth arguing about, while the GATE is where a well-meaning simplification
// does real damage, and it is testable without a network because it was split
// out to be.

use super::*;

/// SHA-256 of the empty input. From FIPS 180-4 / RFC 6234, not from running our
/// own code and writing down what it said — a test vector you generated with
/// the implementation under test proves only that it is deterministic.
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// SHA-256 of `abc`. Same source.
const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fm-update-dl-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn artifact(sha256: &str, size: u64) -> UpdateArtifact {
    UpdateArtifact {
        kind: "msi".to_string(),
        locale: Some("zh-CN".to_string()),
        filename: "FlowMic_0.2.60_x64_zh-CN.msi".to_string(),
        url: "http://example.invalid/a.msi".to_string(),
        sha256: sha256.to_string(),
        size,
    }
}

/// The digest itself, against published vectors.
#[test]
fn the_digest_matches_published_test_vectors() {
    let dir = tmp("vectors");

    let empty = dir.join("empty");
    fs::write(&empty, b"").unwrap();
    assert_eq!(sha256_file(&empty).unwrap(), EMPTY_SHA256);

    let abc = dir.join("abc");
    fs::write(&abc, b"abc").unwrap();
    assert_eq!(sha256_file(&abc).unwrap(), ABC_SHA256);

    // Lowercase hex, 64 chars — the exact shape `manifest.rs` demands, so the
    // comparison in `finalize` is between two normalised values.
    let h = sha256_file(&abc).unwrap();
    assert_eq!(h.len(), 64);
    assert_eq!(h, h.to_ascii_lowercase());

    // Larger than one CHUNK, so the streaming loop is actually exercised —
    // a single-read implementation would pass the three-byte case above and
    // silently hash only the first 64 KiB of a 37 MB installer.
    let big = dir.join("big");
    let payload: Vec<u8> = (0..(CHUNK * 3 + 7)).map(|i| (i % 251) as u8).collect();
    fs::write(&big, &payload).unwrap();
    let streamed = sha256_file(&big).unwrap();
    let one_shot: String = {
        let mut h = Sha256::new();
        h.update(&payload);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    };
    assert_eq!(streamed, one_shot, "the chunked read must hash the WHOLE file");

    let _ = fs::remove_dir_all(&dir);
}

/// 🔴 Rule 2 (§2.4): being unable to compute the hash is a FAILURE, not a pass.
#[test]
fn a_hash_that_cannot_be_computed_is_an_error_not_an_empty_string() {
    let dir = tmp("cannot-hash");
    assert!(sha256_file(&dir.join("does-not-exist")).is_err());
    // A directory is not a file we can hash.
    assert!(sha256_file(&dir).is_err());
    let _ = fs::remove_dir_all(&dir);
}

/// The happy path, and the invariant it establishes.
#[test]
fn a_matching_download_is_renamed_and_only_then_handed_onward() {
    let dir = tmp("ok");
    let a = artifact(ABC_SHA256, 3);
    let part = dir.join(format!("{}.part", a.filename));
    let final_path = dir.join(&a.filename);
    fs::write(&part, b"abc").unwrap();

    let pkg = finalize(&part, &final_path, &a).expect("a matching file must pass the gate");

    assert_eq!(pkg.path(), final_path.as_path());
    assert_eq!(pkg.sha256(), ABC_SHA256);
    assert_eq!(pkg.size(), 3);
    assert_eq!(pkg.kind(), "msi");
    assert!(final_path.is_file(), "the verified file must exist under its final name");
    assert!(!part.exists(), "the .part must be gone after a successful rename");

    let _ = fs::remove_dir_all(&dir);
}

/// 🔴🔴 THE REVERSE-CONTROL TARGET FOR THE WHOLE CARD.
///
/// Make `finalize` accept a mismatched hash — change `if actual != artifact.sha256`
/// to `if false`, or delete the comparison — and this test must go red. It is
/// the assertion standing between a user and an installer whose bytes are not
/// the ones we published, on a plain-HTTP download with no code signature
/// (design §2.1: until stage 2, this hash is the ONLY integrity guarantee).
///
/// It asserts THREE things, and the second is the one usually forgotten:
///   1. the failure is named `HashMismatch`, not a generic error;
///   2. 🔴 **the file is gone from disk** — a rejected installer left lying
///      around is something a confused user can double-click;
///   3. the final name never came into existence.
#[test]
fn a_mismatched_hash_is_refused_and_the_file_is_deleted() {
    let dir = tmp("mismatch");
    // The manifest says this file should hash to the digest of "abc"…
    let a = artifact(ABC_SHA256, 3);
    let part = dir.join(format!("{}.part", a.filename));
    let final_path = dir.join(&a.filename);
    // …and what actually arrived is three different bytes. Same LENGTH on
    // purpose, so the size check cannot be what catches this — the hash must.
    fs::write(&part, b"xyz").unwrap();

    let err = finalize(&part, &final_path, &a).expect_err("a mismatched hash must be refused");

    match &err {
        UpdateFailure::HashMismatch { expected, actual } => {
            assert_eq!(expected, ABC_SHA256);
            assert_ne!(actual, ABC_SHA256);
            assert_eq!(actual.len(), 64);
        }
        other => panic!("expected HashMismatch, got {other:?}"),
    }
    assert!(err.is_blocking(), "a refused package must require explicit dismissal");
    assert!(!part.exists(), "🔴 the rejected download must be DELETED, not left on disk");
    assert!(!final_path.exists(), "🔴 the final name must never have existed");

    let _ = fs::remove_dir_all(&dir);
}

/// 🔴 A truncated download and a substituted file are DIFFERENT sentences.
///
/// This is the common case — connections drop far more often than mirrors are
/// tampered with — so reporting 「安装包校验失败」("installer verification
/// failed") for it would send users to the wrong conclusion most of the time
/// it fires. Folding `SizeMismatch` into
/// `HashMismatch` "because the hash catches it anyway" must turn this red.
#[test]
fn a_truncated_download_says_truncated_not_tampered() {
    let dir = tmp("short");
    let a = artifact(ABC_SHA256, 3);
    let part = dir.join(format!("{}.part", a.filename));
    let final_path = dir.join(&a.filename);
    fs::write(&part, b"a").unwrap(); // one byte of the expected three

    let err = finalize(&part, &final_path, &a).unwrap_err();
    assert_eq!(err, UpdateFailure::SizeMismatch { expected: 3, actual: 1 });
    assert!(!part.exists(), "an incomplete download must not be kept");
    assert!(!final_path.exists());
    // …and it is NOT blocking: retrying a dropped connection is reasonable,
    // whereas a substituted package needs a human to read the sentence.
    assert!(!err.is_blocking());

    let _ = fs::remove_dir_all(&dir);
}

/// A file we cannot even look at is `CannotHash` — never a pass.
#[test]
fn a_file_we_cannot_read_is_cannot_hash() {
    let dir = tmp("unreadable");
    let a = artifact(ABC_SHA256, 3);
    let part = dir.join(format!("{}.part", a.filename));
    let final_path = dir.join(&a.filename);
    // Nothing was ever written there.
    let err = finalize(&part, &final_path, &a).unwrap_err();
    assert_eq!(err.tag(), "cannot_hash");
    assert!(err.is_blocking());
    assert!(!final_path.exists());
    let _ = fs::remove_dir_all(&dir);
}

/// The invariant the `.part` scheme buys, stated as a test: **a file under the
/// final name has passed the gate.** Every refusal above leaves the final name
/// absent, so a later card may rely on this rather than re-deriving it.
#[test]
fn no_refusal_path_can_leave_a_file_under_the_final_name() {
    for (tag, bytes, size) in [
        ("wrong-hash", &b"xyz"[..], 3u64),
        ("truncated", &b"a"[..], 3),
        ("too-long", &b"abcd"[..], 3),
    ] {
        let dir = tmp(tag);
        let a = artifact(ABC_SHA256, size);
        let part = dir.join(format!("{}.part", a.filename));
        let final_path = dir.join(&a.filename);
        fs::write(&part, bytes).unwrap();

        assert!(finalize(&part, &final_path, &a).is_err(), "{tag} must fail");
        assert!(!final_path.exists(), "{tag}: the final name must not exist after a refusal");
        assert!(!part.exists(), "{tag}: the rejected bytes must not be left behind");
        let _ = fs::remove_dir_all(&dir);
    }
}

/// The downloads directory must not become a monotonically growing pile
/// (design §4.3 ②) — each release is tens of megabytes.
#[test]
fn the_sweep_keeps_the_current_target_and_its_in_flight_part() {
    let dir = tmp("sweep");
    let current = "FlowMic_0.2.60_x64_zh-CN.msi";
    for name in [
        current,
        &format!("{current}.part"),
        "FlowMic_0.2.58_x64_zh-CN.msi", // last month's
        "FlowMic_0.2.59_x64_en-US.msi",
        "FlowMic-0.2.57-portable.zip.part", // an abandoned download
    ] {
        fs::write(dir.join(name), b"x").unwrap();
    }
    // A directory in there is left alone — we did not put it there, and
    // recursively deleting unknown directories out of an env-derived path is
    // not a risk this function needs to take.
    fs::create_dir_all(dir.join("subdir")).unwrap();

    let report = sweep_stale(&dir, Some(current));
    assert_eq!(report.removed, 3, "three stale files should go");
    assert_eq!(report.failed, 0);

    assert!(dir.join(current).exists(), "the current target must survive");
    assert!(
        dir.join(format!("{current}.part")).exists(),
        "🔴 an in-flight download of the current target must survive — sweeping at \
         startup while a download runs must not delete that download",
    );
    assert!(dir.join("subdir").is_dir());
    assert!(!dir.join("FlowMic_0.2.58_x64_zh-CN.msi").exists());

    // A missing directory is the normal state before the first download, not an
    // error worth reporting.
    assert_eq!(sweep_stale(&dir.join("nope"), None), SweepReport::default());

    // `None` keeps nothing — the「没有正在进行的更新，全清」("no update is
    // currently in progress, so clear everything") case.
    let report = sweep_stale(&dir, None);
    assert_eq!(report.removed, 2);
    assert_eq!(report.failed, 0);

    let _ = fs::remove_dir_all(&dir);
}

/// The downloads directory is derived from the app's LOCAL home, and is NOT the
/// run directory — they differ by one segment and confusing them would put
/// installers inside the folder a future in-place swap replaces.
#[test]
fn downloads_land_under_the_app_local_home_and_not_the_run_directory() {
    let d = updates_dir();
    assert_eq!(d.file_name().unwrap(), "updates");
    assert_eq!(d.parent().unwrap(), crate::app_dirs::local_home());
    // `install-local.mjs` puts the run copy under `…\Programs\FlowMic\`.
    assert!(
        !d.to_string_lossy().contains("Programs"),
        "downloads must not land in the run directory: {}",
        d.display(),
    );
}
