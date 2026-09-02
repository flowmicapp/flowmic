// SidecarState::claim_bring_up / release_bring_up unit tests, split out of
// sidecar_ctl.rs at its 800-line source cap. Registered from there via
// `#[path = "bring_up_guard_tests.rs"] mod bring_up_guard_tests;` so
// `use super::*` still reaches SidecarState.
use super::*;

/// D8 (2026-09-02 audit §3-D): `SidecarState` needs no Tauri runtime to
/// construct (`new()` is plain atomics/mutexes), so the reentrancy guard's
/// core logic is testable directly — no fake `AppHandle` required. This is
/// the property that stops two overlapping `start()` calls from both
/// running `bring_up_and_connect`: the second claim must fail while the
/// first is still held, and must succeed again once released.
#[test]
fn only_one_bring_up_can_be_claimed_at_a_time() {
    let state = SidecarState::new();
    assert!(state.claim_bring_up(), "the first claim must succeed");
    assert!(!state.claim_bring_up(), "a second claim while the first is held must fail");
    assert!(!state.claim_bring_up(), "still held — repeated claims keep failing, not just once");
    state.release_bring_up();
    assert!(state.claim_bring_up(), "after release, a fresh claim must succeed again");
}

/// Reverse-control shape for the bug this guard fixes: without it (i.e. if
/// `claim_bring_up` always returned `true`), two "callers" of `start()`
/// would both believe they own the bring-up, which is exactly two
/// `node server.js` children racing each other. This test fails on its
/// SECOND assertion if `claim_bring_up` is changed to unconditionally
/// return `true` (the pre-D8 shape, since there was no flag at all).
#[test]
fn a_second_overlapping_start_must_be_told_no() {
    let state = SidecarState::new();
    let first_owns_it = state.claim_bring_up();
    let second_also_thinks_it_owns_it = state.claim_bring_up();
    assert!(first_owns_it);
    assert!(
        !second_also_thinks_it_owns_it,
        "two concurrent bring-ups must never both believe they are the only one"
    );
}
