// NR-267-A — tests for the short-lived ELEVATED refusal memory (socket/dedup_elevated.rs)
// as `run_inject` composes it. A separate file because inject_ops_tests.rs sits near the
// 800-line cap; a child of inject_ops, so it drives the same `run_inject` the socket does.
//
// HOW THESE STAY OFF THE KEYBOARD: every target is a bogus HWND. An equal-integrity frame
// therefore reaches Stage 1, where the real `SetForegroundWindow` answers FALSE and the
// pipeline returns INJECT_FOCUS_LOST before any key or clipboard write. The elevated frame
// is refused by the UIPI hook before Stage 1, through the thread-local test facts.
//
// THE OBSERVABLES for "did not look, did not touch":
//   · `uipi::take_seen()` — every window the pipeline's UIPI hook judged. Empty ⇒ the
//     pipeline was never entered.
//   · the FSM still `SpeakingLocked` ⇒ no `InjectStarted` ⇒ no Stage 1 ⇒ no
//     `SetForegroundWindow`, no clipboard, no `SendInput` (they all live inside it).
// Each negative assertion has a positive control in the same harness that moves both.

use super::*;
use crate::socket::dedup::elevated::{ELEVATED_MEMORY_CAP, ELEVATED_MEMORY_MS};
use inject::uipi::{take_seen, with_test_facts, IntegrityReading::Rid, UipiFacts};

const HWND_ELEVATED: u64 = 0x00E1_E000;
const HWND_ORDINARY: u64 = 0x00A1_A000;

/// An FSM speaking-locked onto `hwnd` (process `notepad`), as if that window is in front.
fn locked_on(hwnd: u64) -> Mutex<FocusStateMachine> {
    let m = Mutex::new(FocusStateMachine::new(1_000));
    {
        let mut g = m.lock().unwrap();
        let _ = g.handle(
            FocusEvent::ForegroundChanged {
                hwnd,
                app_name: "notepad".to_string(),
                window_title: format!("window {hwnd:x}"),
            },
            1,
        );
        let _ = g.handle(FocusEvent::SpeakStarted, 2);
    }
    m
}

fn allow() -> Option<Vec<String>> {
    Some(vec!["notepad".to_string()])
}

fn elevated_facts() -> UipiFacts {
    UipiFacts { sender: Rid(0x2000), sender_ui_access: Some(false), target: Rid(0x3000), target_pid: 42 }
}

fn text_req(rid: &str, origin: inject::InjectOrigin) -> wire::InjectRequest {
    wire::InjectRequest {
        text: "hello there".to_string(),
        source: "stt".to_string(),
        request_id: Some(rid.to_string()),
        entry_id: Some(format!("eid-{rid}")),
        image_b64: None,
        image_mime: None,
        origin,
        origin_stated: true,
    }
}

fn still_locked(fsm: &Mutex<FocusStateMachine>) -> bool {
    matches!(fsm.lock().unwrap().state(), FocusState::SpeakingLocked { .. })
}

/// Refuse `req` against an elevated window in front; returns the refusal frame.
fn refuse_once(req: &wire::InjectRequest, dedup: &Mutex<InjectDeduper>) -> Value {
    let fsm = locked_on(HWND_ELEVATED);
    let _ = take_seen();
    let out = {
        let _g = with_test_facts(elevated_facts());
        run_inject(req, &allow(), &fsm, &Mutex::new(None), dedup, TargetIntent::LiveForeground)
            .expect("a refusal is answered")
    };
    assert_eq!(out["error"], serde_json::json!(error_codes::INJECT_TARGET_ELEVATED), "precondition: refused");
    assert_eq!(take_seen(), vec![HWND_ELEVATED], "precondition: judged on the elevated window");
    out
}

/// 🔴 THE HOLE: refused, the user switches to an ordinary window, an old phone re-sends
/// the same id inside its live window ⇒ the refusal is replayed, the new window is never
/// read or touched. Positive control: a different id in the same harness reaches Stage 1.
#[test]
fn a_resent_elevated_refusal_is_replayed_without_touching_the_window_now_in_front() {
    let dedup = Mutex::new(InjectDeduper::new(64, 1500));
    let req = text_req("rid-same", inject::InjectOrigin::Live);
    let first = refuse_once(&req, &dedup);

    // The user is now in an ORDINARY window (equal integrity: the default test facts).
    let fsm = locked_on(HWND_ORDINARY);
    let dl = Mutex::new(None);
    let again = run_inject(&req, &allow(), &fsm, &dl, &dedup, TargetIntent::LiveForeground).expect("answered");
    assert_eq!(again, first, "the first refusal is replayed verbatim (ids echoed, same verdict)");
    assert_eq!(take_seen(), Vec::<u64>::new(), "the window now in front was never judged");
    assert!(still_locked(&fsm), "no InjectStarted ⇒ no focus switch, no clipboard, no key");
    assert!(dl.lock().unwrap().is_none());

    // POSITIVE CONTROL: a different id in the SAME harness goes through to the pipeline.
    let other = run_inject(&text_req("rid-other", inject::InjectOrigin::Live), &allow(), &fsm, &dl, &dedup, TargetIntent::LiveForeground)
        .expect("answered");
    assert_eq!(take_seen(), vec![HWND_ORDINARY], "a fresh id is judged on the window in front");
    assert_eq!(other["error"], serde_json::json!(error_codes::INJECT_FOCUS_LOST), "reached Stage 1 (bogus hwnd)");
    assert!(!still_locked(&fsm), "the fresh id entered the pipeline");
    assert_eq!(dedup.lock().unwrap().elevated_refusal_count(), 1, "only the ELEVATED outcome is remembered");
}

/// Past the window the same id is judged afresh — the old phone's resend works again.
#[test]
fn after_the_window_the_same_id_is_judged_afresh() {
    let dedup = Mutex::new(InjectDeduper::new(64, 1500));
    let stale_at = (crate::socket::client::now_millis().max(0) as u64) - ELEVATED_MEMORY_MS - 1_000;
    let seeded = serde_json::json!({ "ok": false, "mode": "cached", "error": error_codes::INJECT_TARGET_ELEVATED });
    dedup.lock().unwrap().remember_elevated_refusal(Some("rid-stale"), &seeded, stale_at);

    let fsm = locked_on(HWND_ORDINARY);
    let _ = take_seen();
    let out = run_inject(&text_req("rid-stale", inject::InjectOrigin::Live), &allow(), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground)
        .expect("answered");
    assert_eq!(take_seen(), vec![HWND_ORDINARY], "expired ⇒ the ordinary path judges the window in front");
    assert_eq!(out["error"], serde_json::json!(error_codes::INJECT_FOCUS_LOST));
}

/// A deferred re-send keeps its own answer (never auto-typed, named as deferred).
#[test]
fn a_deferred_resend_of_a_remembered_refusal_keeps_the_deferred_answer() {
    let dedup = Mutex::new(InjectDeduper::new(64, 1500));
    refuse_once(&text_req("rid-d", inject::InjectOrigin::Live), &dedup);
    let fsm = locked_on(HWND_ORDINARY);
    let out = run_inject(&text_req("rid-d", inject::InjectOrigin::Deferred), &allow(), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground)
        .expect("answered");
    assert_eq!(out["error"], serde_json::json!(error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED));
    assert!(still_locked(&fsm));
}

/// Pictures take the same memory: a refused paste is not re-pasted into the next window.
#[test]
fn a_refused_picture_resent_is_replayed_too() {
    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let dedup = Mutex::new(InjectDeduper::new(64, 1500));
    let mut req = text_req("rid-img", inject::InjectOrigin::Live);
    req.source = "image".to_string();
    req.text = String::new();
    req.image_b64 = Some(PNG_1X1.to_string());
    req.image_mime = Some("image/png".to_string());
    if cfg!(target_os = "linux") {
        // Linux has no picture paste: inject/image.rs `decode_pixels` (the
        // not-Windows, not-macOS arm) refuses every picture, and
        // inject/pipeline.rs `inject_image_with_probe` returns that refusal on the
        // PAYLOAD, before any window is looked at. So no elevated refusal exists
        // to replay here. What must hold instead: in front of the elevated window
        // and then the ordinary one, the picture is refused as unsupported and
        // neither window is judged. (The FSM is NOT a usable observable on this
        // path: measured on Linux, it leaves SpeakingLocked even though the
        // refusal comes before any focus or clipboard step.) Public CI for
        // 0.3.118, verify-linux: the Windows-only precondition below failed with
        // INJECT_IMAGE_UNSUPPORTED.
        for hwnd in [HWND_ELEVATED, HWND_ORDINARY] {
            let fsm = locked_on(hwnd);
            let _ = take_seen();
            let out = {
                let _g = with_test_facts(elevated_facts());
                run_inject(&req, &allow(), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground)
                    .expect("answered")
            };
            assert_eq!(out["error"], serde_json::json!(error_codes::INJECT_IMAGE_UNSUPPORTED), "hwnd {hwnd:x}");
            assert_eq!(take_seen(), Vec::<u64>::new(), "no window judged (hwnd {hwnd:x})");
        }
        return;
    }
    let first = refuse_once(&req, &dedup);

    let fsm = locked_on(HWND_ORDINARY);
    let again = run_inject(&req, &allow(), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground).expect("answered");
    assert_eq!(again, first);
    assert_eq!(take_seen(), Vec::<u64>::new());
    assert!(still_locked(&fsm), "no focus switch, no clipboard write");
}

// ── the memory itself ────────────────────────────────────────────────────────

#[test]
fn the_memory_is_bounded_and_evicts_the_oldest() {
    let mut d = InjectDeduper::new(64, 1500);
    let v = serde_json::json!({ "error": error_codes::INJECT_TARGET_ELEVATED });
    for i in 0..ELEVATED_MEMORY_CAP + 10 {
        d.remember_elevated_refusal(Some(&format!("r{i}")), &v, 1_000_000 + i as u64);
    }
    assert_eq!(d.elevated_refusal_count(), ELEVATED_MEMORY_CAP);
    let now = 1_000_000 + ELEVATED_MEMORY_CAP as u64 + 10;
    assert!(d.elevated_refusal_replay(Some("r0"), now).is_none(), "oldest evicted");
    assert!(d.elevated_refusal_replay(Some(&format!("r{}", ELEVATED_MEMORY_CAP + 9)), now).is_some(), "newest kept");
}

#[test]
fn the_window_is_105_s_symmetric_and_never_refreshed_by_a_replay() {
    assert_eq!(ELEVATED_MEMORY_MS, 105_000, "60 s live window + 45 s in-flight watchdog");
    let mut d = InjectDeduper::new(64, 1500);
    let v = serde_json::json!({});
    let t0 = 10_000_000;
    d.remember_elevated_refusal(Some("r"), &v, t0);
    assert_eq!(d.elevated_refusal_replay(Some("r"), t0 + 100_000).map(|(_, age)| age), Some(100_000));
    // A replay did not refresh it: still measured from t0, so 105 s + 1 ms is gone.
    assert!(d.elevated_refusal_replay(Some("r"), t0 + ELEVATED_MEMORY_MS + 1).is_none());
    // A wall clock that jumps BACKWARDS past the window does not keep it alive either.
    d.remember_elevated_refusal(Some("b"), &v, t0);
    assert!(d.elevated_refusal_replay(Some("b"), t0 - ELEVATED_MEMORY_MS - 1).is_none());
    // No id ⇒ nothing to key on ⇒ nothing remembered.
    d.remember_elevated_refusal(None, &v, t0);
    assert_eq!(d.elevated_refusal_count(), 0);
}

/// NR-290: a panic while the table lock was held (poison) must not stop `run_inject`
/// from judging and answering. The refusal (`classify_claiming`, `remember_elevated_refusal`)
/// and its replay (`elevated_refusal_replay`) both go through the poisoned table.
#[test]
fn a_poisoned_dedup_table_still_refuses_and_replays() {
    let dedup = Mutex::new(InjectDeduper::new(64, 1500));
    let poisoner = std::thread::scope(|s| {
        s.spawn(|| {
            let _held = dedup.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            panic!("NR-290 test: a panic while holding the dedup table (expected)");
        })
        .join()
    });
    assert!(poisoner.is_err() && dedup.is_poisoned(), "precondition: the table is poisoned");

    let req = text_req("rid-poisoned", inject::InjectOrigin::Live);
    let first = refuse_once(&req, &dedup);
    let fsm = locked_on(HWND_ORDINARY);
    let again = run_inject(&req, &allow(), &fsm, &Mutex::new(None), &dedup, TargetIntent::LiveForeground).expect("answered");
    assert_eq!(again, first, "the remembered refusal is replayed through the recovered table");
    assert_eq!(take_seen(), Vec::<u64>::new(), "the window now in front was never judged");
    assert!(still_locked(&fsm));
}
