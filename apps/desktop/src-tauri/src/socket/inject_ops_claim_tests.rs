// NR-287 — the in-flight claim as `run_inject` uses it. A child of inject_ops, so it
// drives the same `run_inject` the socket does (table-level cases live in
// dedup_claim_tests.rs).
//
// HOW THIS STAYS OFF THE KEYBOARD: the FSM is speaking-locked onto a bogus HWND of a
// process that the allowlist (`Some(vec![])`) declines, so even a pipeline run that
// should not happen ends at "no target" (cached) without a key or a clipboard write.
//
// THE OBSERVABLES for "the second frame did not run the pipeline":
//   · its reply is the FIRST frame's recorded value, marker field included (a fresh
//     run would build a new cached result without it);
//   · the FSM is still `SpeakingLocked` (a run sends `InjectStarted`).
// Positive control in the same harness: once nothing is in flight, the same frame
// does run (the FSM leaves `SpeakingLocked`).

use super::*;
use crate::socket::dedup::claim::{classify_claiming, Claimed, CLAIM_WAIT_BUDGET};
use std::thread;
use std::time::Duration;

const HWND_BOGUS: u64 = 0x00B0_9000;

fn locked_fsm() -> Mutex<FocusStateMachine> {
    let m = Mutex::new(FocusStateMachine::new(1_000));
    {
        let mut g = m.lock().unwrap();
        let _ = g.handle(
            FocusEvent::ForegroundChanged {
                hwnd: HWND_BOGUS,
                app_name: "notepad".to_string(),
                window_title: "bogus".to_string(),
            },
            1,
        );
        let _ = g.handle(FocusEvent::SpeakStarted, 2);
    }
    m
}

fn still_locked(fsm: &Mutex<FocusStateMachine>) -> bool {
    matches!(fsm.lock().unwrap().state(), FocusState::SpeakingLocked { .. })
}

fn req(rid: &str) -> wire::InjectRequest {
    wire::InjectRequest {
        text: "hello there".to_string(),
        source: "stt".to_string(),
        request_id: Some(rid.to_string()),
        entry_id: Some(format!("eid-{rid}")),
        image_b64: None,
        image_mime: None,
        origin: inject::InjectOrigin::Live,
        origin_stated: true,
    }
}

#[test]
fn a_frame_whose_request_id_is_in_flight_waits_and_replays_instead_of_typing() {
    let dedup = Mutex::new(InjectDeduper::default_spec());
    let fsm = locked_fsm();
    let first_verdict = serde_json::json!({
        "ok": true, "mode": "sendinput", "request_id": "rid-w", "entry_id": "eid-rid-w", "marker": "first-frame",
    });
    // The first frame: holds the claim as if its pipeline were running right now.
    let Claimed::Decided { claim: Some(first), .. } =
        classify_claiming(&dedup, "stt", Some("rid-w"), "hello there", 1, CLAIM_WAIT_BUDGET)
    else {
        panic!("precondition: the first frame owns the id");
    };
    let second = thread::scope(|s| {
        let h = s.spawn(|| {
            run_inject(&req("rid-w"), &Some(vec![]), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground)
        });
        thread::sleep(Duration::from_millis(150));
        assert!(!h.is_finished(), "the second frame must wait while the id is in flight");
        assert!(still_locked(&fsm), "…and must not have entered the pipeline meanwhile");
        dedup.lock().unwrap().record("stt", Some("rid-w"), "hello there", &first_verdict, 3);
        drop(first);
        h.join().unwrap()
    });
    assert_eq!(second, Some(first_verdict), "answered with the first frame's verdict");
    assert!(still_locked(&fsm), "the pipeline was never entered for the second frame");

    // Positive control: nothing in flight, a fresh id ⇒ the same harness DOES run.
    let ran = run_inject(&req("rid-fresh"), &Some(vec![]), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground)
        .expect("answered");
    assert_eq!(ran["mode"], "cached", "no target in this harness ⇒ cached, nothing typed");
    assert!(!still_locked(&fsm), "a real run takes the FSM out of SpeakingLocked");
}

/// NR-288 — `run_inject` waiting on a frame whose pipeline panics answers
/// `INJECT_SUBMISSION_UNCERTAIN` (ok:false) and never enters the pipeline.
#[test]
fn a_frame_waiting_on_a_panicking_run_answers_uncertain_without_typing() {
    let dedup = Mutex::new(InjectDeduper::default_spec());
    let fsm = locked_fsm();
    let (tx, rx) = std::sync::mpsc::channel();
    let second = thread::scope(|s| {
        let holder = s.spawn(|| {
            let Claimed::Decided { claim: Some(_held), .. } =
                classify_claiming(&dedup, "stt", Some("rid-pp"), "hello there", 1, CLAIM_WAIT_BUDGET)
            else {
                panic!("precondition: the first frame owns the id");
            };
            tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(150));
            panic!("the first frame's pipeline blew up");
        });
        rx.recv().unwrap();
        let second = run_inject(&req("rid-pp"), &Some(vec![]), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground);
        assert!(holder.join().is_err(), "precondition: the holder panicked");
        second
    });
    let reply = second.expect("the waiting frame is answered");
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], crate::error_codes::INJECT_SUBMISSION_UNCERTAIN);
    assert_eq!(reply["request_id"], "rid-pp", "the reply echoes this frame's ids");
    assert!(still_locked(&fsm), "the pipeline was never entered for the waiting frame");
}
