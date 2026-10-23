// NR-287 — tests for the in-flight claim (socket/dedup_claim.rs) at the table level.
//
// "The pipeline" here is a stand-in: whoever holds the claim counts one run, holds
// the claim for a while (the window the hole lived in), optionally records a
// result, and drops the claim. The wiring through `run_inject` is pinned
// separately in inject_ops_claim_tests.rs.
//
// Each negative assertion ("the second frame did not run") is paired with a
// positive control in the same harness (a different id DOES run while the first
// is held), so a harness that simply never runs anything cannot pass.

use super::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Barrier};
use std::thread;

const HOLD: Duration = Duration::from_millis(150);

fn table() -> Mutex<InjectDeduper> {
    Mutex::new(InjectDeduper::default_spec())
}

fn typed(rid: &str) -> Value {
    json!({ "ok": true, "mode": "sendinput", "request_id": rid, "marker": "first-frame" })
}

fn claim<'a>(t: &'a Mutex<InjectDeduper>, rid: &str, budget: Duration) -> Claimed<'a> {
    classify_claiming(t, "manual", Some(rid), "hello there", 1, budget)
}

/// The stand-in pipeline: count the run, hold the claim, record (or not), release.
fn run_holding(t: &Mutex<InjectDeduper>, rid: &str, c: InFlightClaim<'_>, runs: &AtomicUsize, record: bool) {
    runs.fetch_add(1, Ordering::SeqCst);
    thread::sleep(HOLD);
    if record {
        t.lock().unwrap().record("manual", Some(rid), "hello there", &typed(rid), 2);
    }
    drop(c);
}

#[test]
fn a_second_frame_for_a_running_id_does_not_run_and_replays_the_first_verdict() {
    let t = table();
    let runs = AtomicUsize::new(0);
    let (tx, rx) = mpsc::channel();
    let second = thread::scope(|s| {
        s.spawn(|| match claim(&t, "rid-1", CLAIM_WAIT_BUDGET) {
            Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(c), waited: None } => {
                tx.send(()).unwrap();
                run_holding(&t, "rid-1", c, &runs, true);
            }
            _ => panic!("the first frame must get the claim"),
        });
        rx.recv().unwrap();
        // The first frame is now inside its pipeline and has not recorded yet.
        match claim(&t, "rid-1", CLAIM_WAIT_BUDGET) {
            Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(c), .. } => {
                run_holding(&t, "rid-1", c, &runs, true);
                None
            }
            Claimed::Decided { decision, claim, waited } => Some((decision, claim.is_some(), waited)),
            Claimed::StillRunning { .. } => panic!("well inside the budget"),
        }
    });
    assert_eq!(runs.load(Ordering::SeqCst), 1, "one request_id, one pipeline run");
    let (decision, has_claim, waited) = second.expect("the second frame must not have run the pipeline");
    assert_eq!(decision, InjectDecision::Replay(typed("rid-1")), "answered with the first frame's verdict");
    assert!(!has_claim, "a replay holds no claim");
    assert!(waited.expect("it had to wait") >= Duration::from_millis(100), "it waited for the first frame");
}

#[test]
fn two_frames_released_at_the_same_instant_run_the_pipeline_exactly_once() {
    for round in 0..20 {
        let t = table();
        let runs = AtomicUsize::new(0);
        let start = Barrier::new(2);
        let rid = format!("rid-race-{round}");
        let answers: Vec<bool> = thread::scope(|s| {
            let frame = || {
                start.wait();
                match claim(&t, &rid, CLAIM_WAIT_BUDGET) {
                    Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(c), .. } => {
                        run_holding(&t, &rid, c, &runs, true);
                        true
                    }
                    Claimed::Decided { decision: InjectDecision::Replay(v), .. } => {
                        assert_eq!(v, typed(&rid));
                        false
                    }
                    _ => panic!("unexpected verdict"),
                }
            };
            let a = s.spawn(frame);
            let b = s.spawn(frame);
            vec![a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(runs.load(Ordering::SeqCst), 1, "round {round}: exactly one pipeline run");
        assert_eq!(answers.iter().filter(|ran| **ran).count(), 1, "round {round}: one ran, one replayed");
    }
}

/// Positive control for the two tests above: the claim is per request_id, not a
/// global lock — a DIFFERENT id runs while the first is held, without waiting.
#[test]
fn a_different_request_id_runs_while_another_is_in_flight() {
    let t = table();
    let Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(held), .. } =
        claim(&t, "rid-a", CLAIM_WAIT_BUDGET)
    else {
        panic!("first id must be claimed");
    };
    match claim(&t, "rid-b", Duration::from_millis(50)) {
        Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(_), waited: None } => {}
        _ => panic!("a different id must proceed at once, with its own claim"),
    }
    drop(held);
}

/// A cached run records nothing (doc 15's 📌 row: judged again, not replayed). The
/// claim must still be released, and the waiting frame then runs the pipeline
/// itself, exactly like a sequential retry. A later frame proceeds too.
#[test]
fn a_run_that_recorded_nothing_releases_the_claim_and_the_next_frame_is_judged_again() {
    let t = table();
    let runs = AtomicUsize::new(0);
    let (tx, rx) = mpsc::channel();
    thread::scope(|s| {
        s.spawn(|| {
            let Claimed::Decided { claim: Some(c), .. } = claim(&t, "rid-c", CLAIM_WAIT_BUDGET) else {
                panic!("first frame must get the claim");
            };
            tx.send(()).unwrap();
            run_holding(&t, "rid-c", c, &runs, false);
        });
        rx.recv().unwrap();
        match claim(&t, "rid-c", CLAIM_WAIT_BUDGET) {
            Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(c), waited: Some(_) } => {
                run_holding(&t, "rid-c", c, &runs, false);
            }
            _ => panic!("after an unrecorded run the waiting frame is judged again and proceeds"),
        }
    });
    assert_eq!(runs.load(Ordering::SeqCst), 2, "two runs, never concurrent");
    assert!(matches!(
        claim(&t, "rid-c", Duration::from_millis(50)),
        Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(_), waited: None }
    ));
}

#[test]
fn a_panicking_run_still_releases_its_claim() {
    let t = table();
    let crashed = thread::scope(|s| {
        s.spawn(|| {
            let Claimed::Decided { claim: Some(_c), .. } = claim(&t, "rid-p", CLAIM_WAIT_BUDGET) else {
                panic!("first frame must get the claim");
            };
            panic!("the pipeline blew up while holding the claim");
        })
        .join()
        .is_err()
    });
    assert!(crashed, "precondition: the run panicked");
    // NR-288: released (no wait, not `StillRunning`), and remembered as uncertain
    // rather than free to run again — the panicking run may have sent keys.
    match claim(&t, "rid-p", Duration::from_millis(50)) {
        Claimed::Decided { decision: InjectDecision::SubmissionUncertainRemembered { mode_wire }, claim: None, waited: None } => {
            assert_eq!(mode_wire, PANIC_MODE_FALLBACK);
        }
        _ => panic!("the claim must not outlive the panic, and the id must not be free to run again"),
    };
}

/// NR-288 — the frame that was WAITING when the holder panicked wakes to the
/// uncertain verdict and runs nothing. Positive control in the same harness: a
/// different id still proceeds, so "nothing ran" is not a harness that never runs.
#[test]
fn a_frame_waiting_on_a_run_that_panics_is_answered_uncertain_and_runs_nothing() {
    let t = table();
    let runs = AtomicUsize::new(0);
    let (tx, rx) = mpsc::channel();
    let second = thread::scope(|s| {
        let holder = s.spawn(|| {
            let Claimed::Decided { claim: Some(_c), .. } = claim(&t, "rid-pw", CLAIM_WAIT_BUDGET) else {
                panic!("first frame must get the claim");
            };
            runs.fetch_add(1, Ordering::SeqCst);
            tx.send(()).unwrap();
            thread::sleep(HOLD);
            panic!("the pipeline blew up after it may have sent keys");
        });
        rx.recv().unwrap();
        let second = match claim(&t, "rid-pw", CLAIM_WAIT_BUDGET) {
            Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(c), .. } => {
                runs.fetch_add(1, Ordering::SeqCst);
                drop(c);
                None
            }
            Claimed::Decided { decision, claim, waited } => Some((decision, claim.is_some(), waited)),
            Claimed::StillRunning { .. } => panic!("well inside the budget"),
        };
        assert!(holder.join().is_err(), "precondition: the holder panicked");
        second
    });
    assert_eq!(runs.load(Ordering::SeqCst), 1, "the waiting frame must not run the pipeline again");
    let (decision, has_claim, waited) = second.expect("the waiting frame must not have run");
    assert_eq!(decision, InjectDecision::SubmissionUncertainRemembered { mode_wire: PANIC_MODE_FALLBACK.into() });
    assert!(!has_claim, "an uncertain answer holds no claim");
    assert!(waited.expect("it had to wait") >= Duration::from_millis(100), "it waited for the holder");
    // A later frame with the same id is answered the same way.
    assert!(matches!(
        claim(&t, "rid-pw", Duration::from_millis(10)),
        Claimed::Decided { decision: InjectDecision::SubmissionUncertainRemembered { .. }, claim: None, .. }
    ));
    // Positive control: the table is not wedged — a different id proceeds.
    assert!(matches!(
        claim(&t, "rid-other", Duration::from_millis(10)),
        Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(_), waited: None }
    ));
}

/// NR-288 — a run that recorded its result and THEN panicked keeps that record:
/// the uncertain mark is only for a run that left nothing behind.
#[test]
fn a_run_that_recorded_before_panicking_keeps_its_record() {
    let t = table();
    let crashed = thread::scope(|s| {
        s.spawn(|| {
            let Claimed::Decided { claim: Some(_c), .. } = claim(&t, "rid-rp", CLAIM_WAIT_BUDGET) else {
                panic!("first frame must get the claim");
            };
            t.lock().unwrap().record("manual", Some("rid-rp"), "hello there", &typed("rid-rp"), 2);
            panic!("blew up after recording");
        })
        .join()
        .is_err()
    });
    assert!(crashed, "precondition: the run panicked");
    match claim(&t, "rid-rp", Duration::from_millis(50)) {
        Claimed::Decided { decision: InjectDecision::Replay(v), claim: None, waited: None } => assert_eq!(v, typed("rid-rp")),
        _ => panic!("a recorded result must survive a later panic"),
    };
}

#[test]
fn a_frame_that_outwaits_the_budget_runs_nothing_and_leaves_the_first_claim_alone() {
    let t = table();
    let Claimed::Decided { claim: Some(held), .. } = claim(&t, "rid-slow", CLAIM_WAIT_BUDGET) else {
        panic!("first frame must get the claim");
    };
    match claim(&t, "rid-slow", Duration::from_millis(60)) {
        Claimed::StillRunning { waited } => assert!(waited >= Duration::from_millis(60)),
        _ => panic!("past the budget the second frame must give up, not run"),
    }
    // The give-up did not release someone else's claim.
    assert!(matches!(claim(&t, "rid-slow", Duration::from_millis(10)), Claimed::StillRunning { .. }));
    drop(held);
    assert!(matches!(
        claim(&t, "rid-slow", Duration::from_millis(10)),
        Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(_), .. }
    ));
}

/// A frame without a request_id is never claimed: INJ-1 and the deliberate-send
/// rule decide it exactly as before, so two id-less deliberate sends both proceed.
#[test]
fn a_frame_without_a_request_id_is_never_claimed() {
    let t = table();
    for _ in 0..2 {
        match classify_claiming(&t, "manual", None, "same bytes", 1, Duration::from_millis(10)) {
            Claimed::Decided { decision: InjectDecision::Proceed, claim: None, waited: None } => {}
            _ => panic!("id-less deliberate send: Proceed, no claim, no wait"),
        }
    }
}

/// NR-288 — the wait budget sits under two clocks this crate cannot import, so the
/// test reads them from their own source files (a restated copy here would not
/// move when they do):
///   · the relay drops a link that has not ponged within `PING_TIMEOUT_MS`
///     (apps/server-core/src/socket/server.ts); a waiting frame blocks its client's
///     only poll thread, which is also the thread that answers engine.io pings, so
///     the budget must leave the pong a margin;
///   · the phone files an attempt as unanswered after `kInjectResultTimeout`
///     (apps/mobile/lib/src/session/compose_gate.dart); a replay from a waiter is
///     only useful before that.
#[test]
fn the_wait_budget_answers_before_the_relay_ping_timeout_and_the_phone_watchdog() {
    fn source(rel: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"))
    }
    fn number_after(src: &str, anchor: &str) -> u64 {
        let at = src.find(anchor).unwrap_or_else(|| panic!("anchor {anchor:?} not found"));
        let digits: String = src[at + anchor.len()..]
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit() || *c == '_')
            .filter(|c| *c != '_')
            .collect();
        digits.parse().unwrap_or_else(|e| panic!("number after {anchor:?}: {e}"))
    }
    let relay_ping_timeout = Duration::from_millis(number_after(
        &source("../../server-core/src/socket/server.ts"),
        "export const PING_TIMEOUT_MS =",
    ));
    let phone_watchdog = Duration::from_secs(number_after(
        &source("../../mobile/lib/src/session/compose_gate.dart"),
        "const Duration kInjectResultTimeout = Duration(seconds:",
    ));
    // Positive control on the parser: both readings are the values the two files
    // carried when this budget was chosen (2026-10-20), not a silent zero.
    assert_eq!(relay_ping_timeout, Duration::from_secs(20), "relay ping timeout as read from server.ts");
    assert_eq!(phone_watchdog, Duration::from_secs(20), "phone watchdog as read from compose_gate.dart");
    const PONG_MARGIN: Duration = Duration::from_secs(5);
    assert!(
        CLAIM_WAIT_BUDGET + PONG_MARGIN <= relay_ping_timeout,
        "a waiting frame must leave the engine.io pong {PONG_MARGIN:?} before the relay drops the link \
         (budget {CLAIM_WAIT_BUDGET:?}, relay ping timeout {relay_ping_timeout:?})"
    );
    assert!(CLAIM_WAIT_BUDGET < phone_watchdog, "a waiter's replay must be able to land before the phone gives up");
}

// ── NR-290 · a poisoned table lock is recovered, not unwrapped ───────────────
// The table is process-wide: one panic while it is held used to make every later
// frame panic at `unwrap()`, so the desktop typed nothing and answered nothing
// until restart. Each test poisons the mutex the way a bug would (a thread panics
// while holding the lock) and asserts a later frame is still judged and answered.

/// A thread panics while holding the table's lock. Asserts the poison took.
fn poison(t: &Mutex<InjectDeduper>) {
    thread::scope(|s| {
        let joined = s
            .spawn(|| {
                let _held = t.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                panic!("NR-290 test: a panic while holding the dedup table (expected)");
            })
            .join();
        assert!(joined.is_err(), "precondition: the holder panicked");
    });
    assert!(t.is_poisoned(), "precondition: the table is poisoned");
}

/// After the poison a fresh id is still claimed, recorded and replayed.
#[test]
fn a_poisoned_table_still_claims_records_and_replays() {
    let t = table();
    poison(&t);
    let Claimed::Decided { decision, claim: Some(c), waited: None } = claim(&t, "rid-poison", HOLD) else {
        panic!("a fresh id on a poisoned table must be claimed and run")
    };
    assert_eq!(decision, InjectDecision::Proceed);
    assert!(!t.is_poisoned(), "recovery clears the flag, so the forensic line is written once per panic");
    lock_table(&t).record("manual", Some("rid-poison"), "hello there", &typed("rid-poison"), 2);
    drop(c);
    let Claimed::Decided { decision: InjectDecision::Replay(v), claim: None, .. } = claim(&t, "rid-poison", HOLD) else {
        panic!("the recorded id must replay")
    };
    assert_eq!(v, typed("rid-poison"));
}

/// A frame waiting on the same id while another thread poisons the table is
/// still answered when the first frame finishes: the first frame's reply.
#[test]
fn a_frame_waiting_while_the_table_is_poisoned_is_answered_with_the_first_reply() {
    let t = table();
    let Claimed::Decided { claim: Some(first), .. } = claim(&t, "rid-pw", HOLD) else { panic!("first frame claims") };
    let replayed = thread::scope(|s| {
        let waiter = s.spawn(|| match claim(&t, "rid-pw", Duration::from_secs(5)) {
            Claimed::Decided { decision: InjectDecision::Replay(v), claim: None, waited: Some(_) } => Some(v),
            _ => None,
        });
        thread::sleep(Duration::from_millis(100)); // the waiter is now asleep on the condvar
        poison(&t); // an unrelated section panics while the waiter sleeps
        lock_table(&t).record("manual", Some("rid-pw"), "hello there", &typed("rid-pw"), 2);
        drop(first);
        waiter.join().expect("the waiting frame must not panic on the poisoned table")
    });
    assert_eq!(replayed, Some(typed("rid-pw")), "the waiter replays the first frame's reply");
}

/// The condvar wait itself reports the poison (`wait_timeout` re-takes the lock):
/// a waiter whose budget runs out on a poisoned table answers `StillRunning`,
/// it does not panic. Nothing else touches the lock after the poison, so the wait
/// is the first lock to see it.
#[test]
fn a_wait_that_times_out_on_a_poisoned_table_reports_still_running() {
    let t = table();
    let Claimed::Decided { claim: Some(first), .. } = claim(&t, "rid-pt", HOLD) else { panic!("first frame claims") };
    let still_running = thread::scope(|s| {
        let waiter = s.spawn(|| matches!(claim(&t, "rid-pt", Duration::from_millis(600)), Claimed::StillRunning { .. }));
        thread::sleep(Duration::from_millis(100)); // the waiter is now asleep on the condvar
        poison(&t);
        waiter.join().expect("the wait must not panic on the poisoned table")
    });
    assert!(still_running, "past the budget the waiter answers StillRunning");
    drop(first);
    // Positive control: the table is usable afterwards and the id is free again.
    assert!(matches!(claim(&t, "rid-pt", HOLD), Claimed::Decided { decision: InjectDecision::Proceed, claim: Some(_), .. }));
}

/// Every production lock of this table goes through `lock_table`; the record in
/// `run_inject` (keyboard path, not reachable without typing) is pinned here.
#[test]
fn production_code_never_unwraps_the_dedup_table_lock() {
    let src = |rel: &str| {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"))
    };
    let inject_ops = src("src/socket/inject_ops.rs");
    assert_eq!(inject_ops.matches("lock_table(deduper)").count(), 3, "the three run_inject locks (positive control)");
    assert!(!inject_ops.contains("deduper.lock()"), "run_inject must lock the table through lock_table");
    let claim_src = src("src/socket/dedup_claim.rs");
    let production = claim_src.split("#[cfg(test)]").next().unwrap_or_default();
    let code: String = production.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    assert!(!code.contains(".unwrap()"), "dedup_claim.rs production code must not unwrap a lock result");
}
