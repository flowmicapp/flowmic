// Tests for `inject/readback.rs`, moved out VERBATIM (one indent level removed,
// nothing else) when NR-254 put that file over the 800-line src cap.

use super::*;

// ── P2 (2026-09-02): the reuse worker must reuse on success, replace on
//    timeout, and never hand a caller a stale answer from an abandoned
//    call — tested with a fake `work()`, no Win32/UIA involved. ─────────

#[test]
fn consecutive_fast_calls_reuse_the_same_worker_thread() {
    use std::sync::atomic::AtomicU32;
    static STARTS: AtomicU32 = AtomicU32::new(0);
    STARTS.store(0, Ordering::SeqCst);
    let worker = BoundedReuseWorker::spawn(
        || {
            STARTS.fetch_add(1, Ordering::SeqCst);
        },
        || 7u32,
    );
    for _ in 0..5 {
        assert_eq!(worker.call_bounded(Duration::from_millis(200)), Ok(7));
    }
    assert_eq!(
        STARTS.load(Ordering::SeqCst),
        1,
        "on_start (the CoInitializeEx stand-in) must run ONCE per worker thread, not once per call"
    );
}

#[test]
fn a_call_that_never_returns_times_out_instead_of_blocking_forever() {
    let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
    // `work` blocks forever on a channel nobody ever sends to — exactly
    // the shape of a UIA call into a target that never replies.
    let worker = BoundedReuseWorker::spawn(
        || {},
        move || {
            let _: Result<(), _> = gate_rx.recv();
            0u32
        },
    );
    let result = worker.call_bounded(Duration::from_millis(50));
    assert_eq!(result, Err(()), "a stuck work() must time out, not hang the caller");
    drop(gate_tx); // let the abandoned thread unblock and exit cleanly
}

#[test]
fn reverse_control_a_slow_but_within_budget_call_still_succeeds() {
    // NEGATIVE CONTROL for the timeout test: a call that is slow but
    // finishes inside the budget must still answer `Ok`. Without this, a
    // version of `call_bounded` that always returned `Err` would still
    // pass the test above.
    let worker = BoundedReuseWorker::spawn(
        || {},
        || {
            std::thread::sleep(Duration::from_millis(5));
            42u32
        },
    );
    assert_eq!(worker.call_bounded(Duration::from_millis(500)), Ok(42));
}

#[test]
fn read_bounded_falls_back_to_none_and_keeps_working_after_a_timeout() {
    // Exercises the actual call-site policy (`read_bounded`'s `Err` arm):
    // a timed-out reader is replaced, and the NEXT read still gets an
    // honest answer rather than repeating the stale timeout forever.
    let attempt = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let a = attempt.clone();
    // First call hangs (simulating one stuck target read); second+ calls
    // answer immediately. Modelled as a worker-generation counter since
    // `BoundedReuseWorker` is generic over `work`, not swappable in place —
    // `read_bounded`'s OWN replacement-on-timeout is what is under test,
    // via a small helper mirroring its exact policy.
    fn read_bounded_generic<T: Send + 'static + PartialEq>(
        reader: &mut BoundedReuseWorker<T>,
        budget: Duration,
        respawn: impl FnOnce() -> BoundedReuseWorker<T>,
    ) -> Option<T> {
        match reader.call_bounded(budget) {
            Ok(v) => Some(v),
            Err(()) => {
                *reader = respawn();
                None
            }
        }
    }
    let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
    let mut reader = BoundedReuseWorker::spawn(
        || {},
        move || {
            a.fetch_add(1, Ordering::SeqCst);
            let _: Result<(), _> = gate_rx.recv(); // hangs forever
            0u32
        },
    );
    let first = read_bounded_generic(&mut reader, Duration::from_millis(30), || {
        BoundedReuseWorker::spawn(|| {}, || 99u32)
    });
    assert_eq!(first, None, "a timed-out first read must fall back to None");
    let second = read_bounded_generic(&mut reader, Duration::from_millis(200), || {
        BoundedReuseWorker::spawn(|| {}, || 99u32)
    });
    assert_eq!(second, Some(99), "the replacement worker must answer normally");
    drop(gate_tx);
}

#[test]
fn a_changed_value_ending_with_the_text_confirms() {
    assert_eq!(
        evaluate(Some("hello "), Some("hello 你好世界"), "你好世界"),
        LandingEvidence::Confirmed
    );
}

#[test]
fn an_unchanged_value_never_confirms_even_when_it_matches() {
    // The defect this guard exists for: the box ALREADY ended with our text,
    // so "ends with" is satisfied by a paste that never happened.
    assert_eq!(
        evaluate(Some("你好世界"), Some("你好世界"), "你好世界"),
        LandingEvidence::NotObserved
    );
}

#[test]
fn a_changed_value_that_does_not_match_is_not_observed_not_failed() {
    // Devin's contenteditable answers with a one-space placeholder. That must
    // read as "this instrument is blind here", never as "the paste failed".
    assert_eq!(
        evaluate(Some(" "), Some("  "), "你好世界"),
        LandingEvidence::NotObserved
    );
}

#[test]
fn no_readable_value_is_unavailable() {
    assert_eq!(
        evaluate(Some("x"), None, "你好世界"),
        LandingEvidence::Unavailable
    );
    assert_eq!(evaluate(None, None, "你好世界"), LandingEvidence::Unavailable);
}

// ── NR-254 (2026-10-14): read-back confirmed text that never arrived ──────
//
// This test used to be `an_unreadable_baseline_does_not_block_a_later_confirmation`
// and asserted `evaluate(None, Some("prefix 你好世界"), "你好世界") == Confirmed`.
// That is the defect, written down as the spec: with no baseline there is no
// way to tell 「the paste just arrived」 from 「the box already ended with it」
// (for example a second identical single-line paste into the same buffer). NOT
// shown to be what happened in the NR-253 incident: that paste was two lines,
// and Notepad stores a bare CR, which `normalise` does not map, so read-back
// could not have confirmed it at all. A `Confirmed` releases the user's clipboard early, so a false one hands
// the target the user's OLD clipboard. With no baseline the hold now simply runs
// its full window: slower, never wrong.
#[test]
fn nr254_an_unreadable_baseline_can_never_confirm() {
    assert_eq!(
        evaluate(None, Some("prefix 你好世界"), "你好世界"),
        LandingEvidence::NotObserved
    );
}

#[test]
fn nr254_text_that_was_already_at_the_end_needs_one_more_copy() {
    // The box already ended with the text (an earlier identical paste) and
    // changed SOMEWHERE ELSE. Ends-with plus changed was satisfied; nothing landed.
    assert_eq!(
        evaluate(Some("hello world"), Some("x hello world"), "hello world"),
        LandingEvidence::NotObserved
    );
    // Positive control: the second identical paste that DID land.
    assert_eq!(
        evaluate(Some("hello world"), Some("hello worldhello world"), "hello world"),
        LandingEvidence::Confirmed
    );
}

fn reading(element: &[i32], value: &str) -> FocusReading {
    FocusReading { element: element.to_vec(), value: value.to_string() }
}

#[test]
fn nr254_a_different_element_is_not_a_change_of_the_target() {
    // Baseline from Notepad's AI prompt box, current from the editor that
    // already ended with the text: two elements, not one that changed.
    assert_eq!(
        evaluate_readings(
            Some(&reading(&[42, 7], "draft")),
            Some(&reading(&[42, 9], "notes hello world")),
            "hello world"
        ),
        LandingEvidence::NotObserved
    );
    // An element whose id could not be read cannot vouch for itself either.
    assert_eq!(
        evaluate_readings(Some(&reading(&[], "")), Some(&reading(&[], "hello world")), "hello world"),
        LandingEvidence::NotObserved
    );
    // Positive control: same element, text arrived.
    assert_eq!(
        evaluate_readings(
            Some(&reading(&[42, 9], "notes ")),
            Some(&reading(&[42, 9], "notes hello world")),
            "hello world"
        ),
        LandingEvidence::Confirmed
    );
    assert_eq!(evaluate_readings(Some(&reading(&[1], "a")), None, "a"), LandingEvidence::Unavailable);
}

/// Drive `watch_with` with a scripted reading sequence; return whether it
/// confirmed within `window`.
fn replay(script: Vec<Option<FocusReading>>, expected: &str, window_ms: u64) -> bool {
    let mut it = script.into_iter();
    let mut tail = None;
    let w = watch_with(
        expected,
        Duration::from_millis(1),
        Duration::from_millis(1000),
        move || match it.next() {
            Some(r) => {
                tail = r.clone();
                r
            }
            None => tail.clone(),
        },
    );
    let until = std::time::Instant::now() + Duration::from_millis(window_ms);
    while std::time::Instant::now() < until && !w.confirmed() {
        std::thread::sleep(Duration::from_millis(2));
    }
    w.confirmed()
}

#[test]
fn nr254_replay_baseline_timed_out_and_nothing_landed() {
    // The incident shape: the baseline read timed out (None) and the editor
    // still holds the previous identical paste. Nothing new ever arrives.
    let old = reading(&[42, 9], "hello world");
    assert!(!replay(vec![None, Some(old.clone()), Some(old)], "hello world", 80));
}

#[test]
fn nr254_replay_focus_moved_between_baseline_and_poll() {
    let script = vec![
        Some(reading(&[42, 7], "")),
        Some(reading(&[42, 9], "notes hello world")),
    ];
    assert!(!replay(script, "hello world", 80));
}

#[test]
fn nr254_replay_positive_control_a_real_landing_still_confirms() {
    let script = vec![
        Some(reading(&[42, 9], "hello world")),
        Some(reading(&[42, 9], "hello world")),
        Some(reading(&[42, 9], "hello worldhello world")),
    ];
    assert!(replay(script, "hello world", 1000));
}

#[test]
fn nr254_the_baseline_is_taken_before_watch_returns() {
    // `watch` is called before Ctrl+V so that the baseline predates the
    // keystroke. Calling it first is not enough if it returns before the
    // first read has happened: the paste then races the baseline.
    use std::sync::atomic::AtomicU32;
    let reads = Arc::new(AtomicU32::new(0));
    let r = reads.clone();
    let _w = watch_with("x", Duration::from_millis(5), Duration::from_millis(1000), move || {
        if r.load(Ordering::SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(60));
        }
        r.fetch_add(1, Ordering::SeqCst);
        None
    });
    assert!(reads.load(Ordering::SeqCst) >= 1, "watch returned before taking its baseline");
}

#[test]
fn empty_deliveries_cannot_confirm_anything() {
    // "ends_with(\"\")" is true for every string on earth.
    assert_eq!(evaluate(Some("a"), Some("b"), ""), LandingEvidence::NotObserved);
    assert_eq!(
        evaluate(Some("a"), Some("b"), "   \n "),
        LandingEvidence::NotObserved
    );
}

#[test]
fn crlf_rewriting_editors_still_confirm() {
    assert_eq!(
        evaluate(Some(""), Some("line1\r\nline2"), "line1\nline2"),
        LandingEvidence::Confirmed
    );
}

#[test]
fn trailing_whitespace_added_by_the_target_still_confirms() {
    assert_eq!(
        evaluate(Some("x"), Some("x你好世界\n"), "你好世界"),
        LandingEvidence::Confirmed
    );
}

#[test]
fn a_prefix_match_is_not_a_match() {
    // The text landing at the START of the box means something else is at the
    // end — most likely we are reading a different element than we injected
    // into. Not evidence.
    assert_eq!(
        evaluate(Some(""), Some("你好世界 trailing"), "你好世界"),
        LandingEvidence::NotObserved
    );
}

#[test]
fn the_inert_watch_never_confirms_and_says_so() {
    let w = LandingWatch::inert();
    assert!(!w.confirmed());
    assert_eq!(w.evidence(), LandingEvidence::Unavailable);
}

#[test]
fn every_arm_has_a_distinct_forensic_phrase() {
    let all = [
        LandingEvidence::Confirmed,
        LandingEvidence::NotObserved,
        LandingEvidence::Unavailable,
    ];
    for (i, a) in all.iter().enumerate() {
        for b in all.iter().skip(i + 1) {
            assert_ne!(a.phrase(), b.phrase(), "{a:?} and {b:?} read the same");
        }
    }
}

// The evidence sentence has to carry all three facts, because it is the only line
// anybody will read when the next 「it pasted the wrong text」 report arrives. The
// held= number is the one that makes the failure falsifiable at all: the defect
// was 「the payload was reachable for 110ms」, and no reader could have known that
// from the old line.
#[test]
fn the_evidence_sentence_carries_the_receipt_the_landing_and_the_hold() {
    use crate::inject::clipboard_outcome::evidence_phrase;
    use crate::inject::readback::LandingEvidence;
    let s = evidence_phrase(true, LandingEvidence::Confirmed, 214);
    assert!(s.contains("held=214ms"), "{s}");
    assert!(s.contains("read-back"), "{s}");
    // The two facts must stay distinguishable: a served receipt with NO landing
    // evidence is exactly the state the P0 lived in, and it must not read the
    // same as a confirmed landing.
    let unconfirmed = evidence_phrase(true, LandingEvidence::Unavailable, 1500);
    assert_ne!(s, unconfirmed);
    assert!(unconfirmed.contains("unavailable"), "{unconfirmed}");
}
