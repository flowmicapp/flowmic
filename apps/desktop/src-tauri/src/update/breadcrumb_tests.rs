// Tests for `breadcrumb.rs`.
//
// The breadcrumb is the ONLY channel from「after we exited」back to「the next
// time we run」, so the properties worth asserting are about what it refuses to
// say, not about serde round-tripping.

use super::*;

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("fm-update-crumb-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn crumb() -> Breadcrumb {
    Breadcrumb {
        from: "0.2.59".to_string(),
        to: "0.2.60".to_string(),
        kind: PendingKind::Portable,
        started_at: "2026-08-08T09:12:00Z".to_string(),
        detail: None,
    }
}

#[test]
fn a_breadcrumb_survives_a_write_and_a_read() {
    let dir = tmp("roundtrip");
    write_in(&dir, &crumb()).unwrap();
    assert_eq!(read_in(&dir).unwrap(), crumb());
    clear_in(&dir);
    assert!(read_in(&dir).is_none());
}

/// The mover's verdict is the field that turns「it didn't work」into「it didn't
/// work AND your old copy is back」.
#[test]
fn the_movers_detail_survives_the_trip() {
    let dir = tmp("detail");
    let mut c = crumb();
    c.detail = Some("rolled_back:PermissionDenied".to_string());
    write_in(&dir, &c).unwrap();
    let back = read_in(&dir).unwrap();
    assert_eq!(back.detail.as_deref(), Some("rolled_back:PermissionDenied"));
}

/// 🔴 A corrupt breadcrumb reads as「I have nothing to tell you about last
/// time」— never as an invented sentence, and never as a reason to fail a launch.
///
/// The direction matters: losing the file makes us claim LESS knowledge. A parse
/// that fell back to a default `Breadcrumb` would announce an update attempt that
/// never happened, on every launch, from a truncated write.
#[test]
fn an_unreadable_breadcrumb_says_nothing_rather_than_something_wrong() {
    let dir = tmp("corrupt");
    std::fs::write(dir.join("update-pending.json"), b"{ this is not json").unwrap();
    assert!(read_in(&dir).is_none());
    std::fs::write(dir.join("update-pending.json"), b"{}").unwrap();
    assert!(read_in(&dir).is_none(), "a JSON object missing every field is not a breadcrumb");
}

/// The judgement is「what version am I now」, full stop.
#[test]
fn arriving_on_the_target_version_is_the_only_success() {
    assert_eq!(
        evaluate(&crumb(), "0.2.60"),
        PendingOutcome::Completed { to: "0.2.60".to_string() },
    );
    assert_eq!(evaluate(&crumb(), "0.2.60").tag(), "completed");
}

/// 🔴 Still on the old version, or on some third version, both mean「你没有装上
/// 0.2.60」("you did not get 0.2.60 installed") — the sentence merges, the
/// record does not.
#[test]
fn any_version_that_is_not_the_target_is_an_incomplete_update() {
    for current in ["0.2.59", "0.2.58", "0.3.0", "not-a-version", ""] {
        match evaluate(&crumb(), current) {
            PendingOutcome::NotCompleted { from, to, current: c, .. } => {
                assert_eq!(from, "0.2.59");
                assert_eq!(to, "0.2.60");
                // The surprise is CARRIED even though the sentence merges — the
                // merge is in the wording, not in the evidence.
                assert_eq!(c, current);
            }
            PendingOutcome::Completed { .. } => {
                panic!("running {current} is not running 0.2.60");
            }
        }
    }
}

/// 🔴 Nothing this module produces may be read as「已是最新」("already up to date") or as a success when
/// it is not one. The chain's whole promise is that a failure after our exit gets
/// SAID; a breadcrumb that congratulated the user on an update that did not
/// happen would be the loudest possible version of the thing this card exists to
/// prevent.
#[test]
fn an_incomplete_update_can_never_be_tagged_as_completed() {
    let mut c = crumb();
    c.detail = Some("rollback_failed:PermissionDenied/NotFound".to_string());
    assert_eq!(evaluate(&c, "0.2.59").tag(), "not_completed");
    // …including when the mover said nothing at all, which is what a machine that
    // was switched off mid-update looks like.
    let silent = crumb();
    assert_eq!(evaluate(&silent, "0.2.59").tag(), "not_completed");
}

/// The running build's own version is a real `x.y.z`, so `evaluate` is comparing
/// against something meaningful rather than an empty string.
#[test]
fn the_current_version_is_the_crates_own() {
    let v = current_version();
    assert_eq!(v, env!("CARGO_PKG_VERSION"));
    assert_eq!(v.split('.').count(), 3, "expected x.y.z, got `{v}`");
}
