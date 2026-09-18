use super::*;
use std::path::PathBuf;

/// The prefix lives in two languages and cannot be imported across them: Rust
/// builds the literal, node scans for it. So the pair is pinned here rather
/// than trusted — a rename on either side, with nothing checking, would leave
/// GATE 0f scanning for a string no build produces and reporting BLIND on every
/// correct exe. (The gate treats blind as a refusal, so the failure direction is
/// closed; this test is what keeps it from happening at all.)
#[test]
fn stamp_prefix_matches_the_node_side() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("scripts")
        .join("build-stamp")
        .join("require-clean-sha.mjs");
    let Ok(js) = std::fs::read_to_string(&path) else {
        // The open-source export may drop release tooling; a missing file is
        // not a failing assertion about this crate.
        return;
    };
    let needle = "export const STAMP_PREFIX = '";
    let at = js.find(needle).expect("STAMP_PREFIX not found in require-clean-sha.mjs");
    let rest = &js[at + needle.len()..];
    let prefix = &rest[..rest.find('\'').expect("unterminated STAMP_PREFIX literal")];
    assert!(
        STAMP.starts_with(prefix),
        "the exe stamps {STAMP:?} but scripts/build-stamp/require-clean-sha.mjs scans for \
         {prefix:?} — publish GATE 0f would read every build as BLIND",
    );
}

/// `unstamped-dev` is what a plain `cargo test` gets, and it must not be
/// mistaken for a commit — that judgement is what the startup line and GATE 0f
/// both branch on.
#[test]
fn a_developer_build_does_not_claim_a_commit() {
    if BUILD_SHA == "unstamped-dev" || BUILD_SHA == "nogit" {
        assert!(!is_stamped());
        assert!(startup_line().contains("cannot name its commit"));
    } else {
        // A stamped build: either a clean sha or the deliberately-refused dirty
        // form. Neither may be silently reported as the other.
        assert!(
            is_stamped() || BUILD_SHA.starts_with("dirty-"),
            "unexpected build stamp {BUILD_SHA:?}",
        );
    }
}

#[test]
fn the_stamp_is_one_literal_carrying_the_value() {
    assert_eq!(STAMP, format!("flowmic-build-sha:{BUILD_SHA}"));
}
