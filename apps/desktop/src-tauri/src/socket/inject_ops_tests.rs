// Tests for socket/inject_ops.rs, split out under `#[path]` for the 800-line src
// cap (the same shape pipeline.rs uses for pipeline_tests.rs and row_transit.rs for
// row_transit_tests.rs). 🔴 NOTHING HERE CHANGED IN THE MOVE — every assertion is
// the verbatim text that was in inject_ops.rs's inline `mod tests`, de-indented one
// level because the FILE is the module now. Any diff beyond "the move" would be a bug
// in this split rather than a change anyone asked for.
//
// What the move made room for: IJ-01's focus-observation tests, which belong beside
// the composition they assert (`run_inject` consulting the gate, in the right ORDER)
// rather than beside the pure functions in pipeline_tests.rs.

use super::*;

/// RV-25. The three silent exits are Win32-bound (SetForegroundWindow /
/// SendInput), so what is asserted here is the part that CAN be asserted
/// without typing into a real window: every exit has a line, the four lines
/// are DISTINCT, and each one names its own failed precondition. The wiring
/// (each exit calls `record` with its own variant) is one `match` arm per
/// variant in `run_control_key` and is verified by diff review — nothing was
/// stubbed out to make it testable.
#[test]
fn every_chord_exit_has_a_line_that_names_the_failed_precondition() {
    let exits = [
        ChordExit::Sent,
        ChordExit::SendFailed("the OS rejected the flow-key chord (returned 0)".into()),
        ChordExit::ForegroundRefused,
        ChordExit::NoTarget,
        // 🔴 2026-08-07: was the bare literal "INJECT_ACCESSIBILITY_NOT_GRANTED".
        // The production construction a few lines up passes
        // `refused.error_code` straight through, so it is name-agnostic and the
        // rename to `INJECT_NO_ACCESSIBILITY` could not reach it — but a literal
        // HERE would have kept asserting a code that no longer exists anywhere,
        // and gone on passing. A fixture spelled by hand is a second source of
        // truth for the same string; this one now tracks the constant.
        ChordExit::OsWillNotDeliver(error_codes::INJECT_NO_ACCESSIBILITY.into()),
    ];
    let lines: Vec<String> = exits.iter().map(|e| e.line("clear", Some(0xAB), 2)).collect();

    // Distinct: two exits that log the same words are one exit as far as the
    // forensic trail is concerned — which is the state this card came to fix.
    for (i, a) in lines.iter().enumerate() {
        for b in lines.iter().skip(i + 1) {
            assert_ne!(a, b, "two chord exits produced the same line");
        }
    }
    // Every line names the kind and is non-trivial.
    for l in &lines {
        assert!(l.contains("clear"), "the line must name the kind: {l}");
        assert!(l.len() > 20, "a one-word line answers nothing: {l}");
    }
    // The four NON-delivering exits must say NOT sent plus the precondition.
    assert!(lines[1].contains("NOT sent") && lines[1].contains("OS refused"));
    assert!(lines[2].contains("NOT sent") && lines[2].contains("SetForegroundWindow"));
    assert!(lines[3].contains("NOT sent") && lines[3].contains("no inject target"));
    assert!(
        lines[4].contains("NOT sent")
            && lines[4].contains(error_codes::INJECT_NO_ACCESSIBILITY),
        "the OS-refusal line must name WHICH condition held: {}",
        lines[4]
    );
    // …and it must record that the foreground was left alone, because that is
    // the user-visible difference between this exit and every other one.
    assert!(
        lines[4].contains("foreground NOT taken"),
        "a refusal that stole the foreground on its way to doing nothing is a \
         different (worse) bug, and the log has to tell them apart: {}",
        lines[4]
    );
    // …and the delivering one must NOT claim a failure (no false negatives).
    assert!(lines[0].contains("sent") && !lines[0].contains("NOT sent"));
}

/// 🔴 W3 2026-08-07 — the chord path really does consult the synthetic-input
/// gate. This exists because `flow_key.rs` carried a comment ASSERTING it
/// while the only production caller did not call it at all: `run_control_key`
/// went straight from `set_foreground_window` to `send_chords`, so on a macOS
/// box without Accessibility every discarded keystroke was logged as
/// "chord … sent". `control:key` has no result frame, so that line is its
/// ONLY evidence surface.
///
/// A grep anchor alone would not have caught the original defect (the comment
/// named a real function that really existed — it just was not on this path),
/// so the claim is pinned by execution instead.
#[test]
fn the_chord_path_consults_the_synthetic_input_gate_before_touching_the_foreground() {
    use crate::inject::preflight::{with_test_facts, SyntheticInputFacts};

    // The gate says "the OS will discard this" ⇒ the chord path must not post,
    // and must not raise anybody either.
    let _g = with_test_facts(SyntheticInputFacts {
        accessibility_trusted: false,
        secure_event_input: false,
    });
    assert!(
        crate::inject::preflight::synthetic_input_preflight().is_some(),
        "precondition: the seam must be refusing for this test to mean anything"
    );

    // POSITIVE CONTROL — without it this test would pass against a gate that
    // refuses unconditionally, which is a different bug wearing the same green.
    drop(_g);
    assert!(
        crate::inject::preflight::synthetic_input_preflight().is_none(),
        "the default must let frames through, or the assertion above proves nothing"
    );
}

#[test]
fn a_send_failure_carries_the_underlying_error_text() {
    // `map_image_outcome`'s lesson (see the inject resolve line above): an error
    // whose detail is dropped makes every failure read identically. The chord
    // path has two distinct FlowKeyErrors, so the text has to travel.
    let rejected = inject::FlowKeyError::Rejected;
    let win32 = inject::FlowKeyError::Win32(5);
    let a = ChordExit::SendFailed(rejected.to_string()).line("enter", Some(1), 1);
    let b = ChordExit::SendFailed(win32.to_string()).line("enter", Some(1), 1);
    assert_ne!(a, b, "two different SendInput failures must not read the same");
    assert!(b.contains('5'), "the Win32 code must survive into the log: {b}");
}

// ── 🔴 L8 · Deferred-delivery messages must not be auto-injected, asserted on the COMPOSITION ─────────────
//
// pipeline_tests.rs pins the gate as a pure function. What can only be asserted
// HERE is that `run_inject` actually consults it, and consults it in the right
// ORDER — "a function was written but nobody calls it" is this repo's #1 historical bug class.
//
// ⚠️ HOW THIS IS SAFE TO RUN. `run_inject` ends in real SendInput, so the test
// hands it an EMPTY smoke allowlist: `apply_allowlist` then resolves NO target,
// and `inject_text` returns at Stage 1 without calling the focus switcher or
// touching the keyboard. That is also what makes the control meaningful — the
// live frame provably travels all the way THROUGH the gate and into the
// pipeline, and says so by coming back with the pipeline's OWN code.
fn deferred_probe_env() -> (Option<Vec<String>>, Mutex<FocusStateMachine>, Mutex<Option<Instant>>, Mutex<InjectDeduper>) {
    (
        Some(Vec::new()), // nothing is allowed → no target → no keystroke, ever
        Mutex::new(FocusStateMachine::new(1_000)),
        Mutex::new(None),
        Mutex::new(InjectDeduper::new(64, 1500)),
    )
}

fn req(origin: inject::InjectOrigin, marker: &str) -> wire::InjectRequest {
    wire::InjectRequest {
        text: marker.to_string(),
        source: "stt".to_string(),
        request_id: Some(format!("rid-{marker}")),
        entry_id: Some(format!("eid-{marker}")),
        image_b64: None,
        image_mime: None,
        origin,
        origin_stated: true,
    }
}

#[test]
fn a_deferred_frame_is_refused_by_name_and_a_live_one_is_not() {
    let (allow, fsm, dl, dedup) = deferred_probe_env();

    // 🔴 THE POSITIVE CONTROL, and it comes FIRST on purpose: if the live frame
    // did not reach the pipeline, the deferred assertion below would be
    // satisfied by a `run_inject` that refuses everything.
    let live = run_inject(&req(inject::InjectOrigin::Live, "live"), &allow, &fsm, &dl, &dedup, TargetIntent::LiveForeground)
        .expect("a live frame must still produce a verdict");
    assert_eq!(live["ok"], serde_json::json!(false), "no target in this harness");
    assert_eq!(
        live["error"],
        serde_json::json!(error_codes::INJECT_FOCUS_LOST),
        "a live frame must travel through the gate into the PIPELINE — its verdict has \
         to be the pipeline's own Stage-1 code, not the deferred refusal"
    );

    let deferred = run_inject(&req(inject::InjectOrigin::Deferred, "deferred"), &allow, &fsm, &dl, &dedup, TargetIntent::LiveForeground)
        .expect("a deferred delivery must still be ANSWERED — silence is the red line");
    assert_eq!(deferred["ok"], serde_json::json!(false));
    assert_eq!(deferred["mode"], serde_json::json!("cached"), "delivered successfully, not injected · cached");
    assert_eq!(
        deferred["error"],
        serde_json::json!(error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED),
        "the refusal must be NAMED, and named differently from \"focus not found\""
    );
    // A-58: the verdict still echoes both correlation keys, or the phone's queue
    // cannot find the item this answer belongs to and the delivery hangs.
    assert_eq!(deferred["request_id"], serde_json::json!("rid-deferred"));
    assert_eq!(deferred["entry_id"], serde_json::json!("eid-deferred"));
    // A non-delivery claims no place: 04 §3.5 — the same rule every other
    // failure path follows.
    assert!(deferred.get("inject_target").is_none());
    assert!(deferred.get("target_window").is_none());
}

#[test]
fn dedup_runs_before_the_deferred_gate_so_a_typed_utterance_never_goes_backwards() {
    // 🔴 THE ORDERING BUG THIS EXISTS TO PREVENT. The phone's queue re-sends an
    // unanswered delivery under the SAME `request_id`, and by then it is a
    // re-delivery — stamped `deferred`. If the gate ran ahead of INJ-3, a frame
    // that had really been TYPED would be answered "not injected" on its retry and the
    // phone's row would move from injected back to cached.
    let (allow, fsm, dl, dedup) = deferred_probe_env();
    // Seed the deduper the way a genuine delivery does: a verdict recorded under
    // this request_id. (`run_inject` only records non-cached outcomes, which this
    // harness cannot produce without typing — so the record is placed directly,
    // which is exactly the state a real typed frame leaves behind.)
    let typed = serde_json::json!({ "ok": true, "mode": "sendinput", "request_id": "rid-x" });
    dedup.lock().unwrap().record("stt", Some("rid-x"), "hello", &typed, 1_000);

    let retry = wire::InjectRequest {
        text: "hello".to_string(),
        source: "stt".to_string(),
        request_id: Some("rid-x".to_string()),
        entry_id: None,
        image_b64: None,
        image_mime: None,
        origin: inject::InjectOrigin::Deferred,
        origin_stated: true,
    };
    let out = run_inject(&retry, &allow, &fsm, &dl, &dedup, TargetIntent::LiveForeground).expect("a replay answers");
    assert_eq!(
        out["ok"],
        serde_json::json!(true),
        "the ORIGINAL verdict must be replayed verbatim; the deferred gate must not \
         overwrite a delivery that really happened"
    );
    assert_eq!(out["mode"], serde_json::json!("sendinput"));
}

// ── 🔴 IJ-01 · the focus OBSERVATION, asserted on the COMPOSITION ───────────
//
// wire_tests.rs pins the frame SHAPE. What can only be asserted here is which
// branches fill it — "each of the four branches decides for itself, no blanket shortcut" (spec §A-1/§A-4) — and that the
// deferred branch's new read did not cost it the property that made it safe.
//
// ⚠️ HOW THESE ARE SAFE TO RUN. `run_inject` ends in a REAL SendInput. Two
// harnesses keep the keyboard out of it, and each one is also what makes its own
// assertion meaningful:
//   · the empty allowlist above — no target resolves at all;
//   · `locked_env` below — a target resolves (so `focus_window` has something to
//     report) but its HWND is deliberately bogus, so the real
//     `SetForegroundWindow` answers FALSE and Stage 1 ends the frame before any
//     key is sent. That is the ordinary "injection failed" path, which is precisely the
//     path this card exists to make able to name a window.

/// The hwnd the FSM lock is seeded with. Not a window: `SetForegroundWindow` on an
/// invalid handle returns FALSE, which ends Stage 1 with INJECT_FOCUS_LOST and
/// keeps every test in this section off the keyboard.
const BOGUS_HWND: u64 = 0x00DE_AD00;

/// An FSM already SPEAKING-locked onto a named window, plus an allowlist that
/// admits it. `resolve_inject_target` then answers from the LOCK and never asks
/// the OS what is really in front of the machine running the suite — memory
/// "check your ruler first": a test whose answer depends on the developer's foreground is a
/// measurement of the box, not of the product.
fn locked_env() -> (Option<Vec<String>>, Mutex<FocusStateMachine>, Mutex<Option<Instant>>, Mutex<InjectDeduper>) {
    let fsm = FocusStateMachine::new(1_000);
    let m = Mutex::new(fsm);
    {
        let mut g = m.lock().unwrap();
        let _ = g.handle(
            FocusEvent::ForegroundChanged {
                hwnd: BOGUS_HWND,
                app_name: "notepad".to_string(),
                window_title: "Untitled - Notepad".to_string(),
            },
            1,
        );
        let _ = g.handle(FocusEvent::SpeakStarted, 2);
    }
    (
        Some(vec!["notepad".to_string()]),
        m,
        Mutex::new(None),
        Mutex::new(InjectDeduper::new(64, 1500)),
    )
}

/// 🔴 §A-1 row 1 — THE DEFECT THIS CARD FIXES. A delivery that was not injected
/// used to answer with `ok:false` and nothing else; the window had been resolved
/// and discarded. Now it says which one.
#[test]
fn a_failed_injection_reports_the_window_it_was_aimed_at() {
    let (allow, fsm, dl, dedup) = locked_env();
    let out = run_inject(&req(inject::InjectOrigin::Live, "obs"), &allow, &fsm, &dl, &dedup, TargetIntent::LiveForeground)
        .expect("a live frame produces a verdict");
    // PRECONDITION: this really is the failure path, not an accidental success.
    assert_eq!(out["ok"], serde_json::json!(false));
    assert_eq!(out["error"], serde_json::json!(error_codes::INJECT_FOCUS_LOST));
    // …and it names the window anyway, which is the whole card.
    assert_eq!(out["focus_window"]["process_name"], serde_json::json!("notepad"));
    assert_eq!(
        out["focus_window"]["window_title"],
        serde_json::json!("Untitled - Notepad")
    );
    // 🔴 …while `inject_target` stays ok:true-only. Widening THAT key instead is
    // the option the design rejected: it would have forced an `injected_at` onto a
    // result that never injected (design §4-3).
    assert!(out.get("inject_target").is_none());
    assert!(out.get("target_window").is_none());
    // 🔴 §A-4: Stage 1 ended the frame, so Stage 1b never ran ⇒ ABSENT, not
    // 'unknown'. This is the assertion that separates "we never asked" from a fabricated
    // measurement, and it is the one a careless implementation gets wrong.
    assert!(
        out.get("focus_evidence").is_none(),
        "a frame that died at Stage 1 never probed — it must not ship a reading"
    );
}

/// 🔴 §A-2 — the deferred-delivery branch now READS a target (to report it) and still must not
/// TOUCH one. The observable proof available without a real desktop is the FSM:
/// `FocusEvent::InjectStarted` is driven immediately before the pipeline, and the
/// focus switcher lives strictly inside it (`stage1_focus`), so a lock that is
/// still `SpeakingLocked` afterwards proves the pipeline was never entered and
/// therefore that `SetForegroundWindow` was never called.
#[test]
fn the_deferred_branch_reports_the_window_without_ever_taking_the_foreground() {
    let (allow, fsm, dl, dedup) = locked_env();
    let out = run_inject(
        &req(inject::InjectOrigin::Deferred, "obs-deferred"),
        &allow,
        &fsm,
        &dl,
        &dedup,
        TargetIntent::LiveForeground,
    )
    .expect("a deferred delivery must still be ANSWERED — silence is the red line");
    assert_eq!(
        out["error"],
        serde_json::json!(error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED)
    );
    // It observed the window …
    assert_eq!(out["focus_window"]["process_name"], serde_json::json!("notepad"));
    // … and did NOT probe it (§A-4: the pipeline was never entered).
    assert!(out.get("focus_evidence").is_none());
    // 🔴 THE PROPERTY THE NEW READ MUST NOT HAVE COST. Still locked ⇒ no
    // InjectStarted ⇒ no Stage 1 ⇒ no `SetForegroundWindow`, no keystroke.
    assert!(
        matches!(
            fsm.lock().unwrap().state(),
            FocusState::SpeakingLocked { .. }
        ),
        "the deferred branch drove an FSM transition — it entered the pipeline"
    );
    assert!(dl.lock().unwrap().is_none(), "no watchdog was armed or disarmed");

    // 🔴 THE POSITIVE CONTROL, and without it the assertion above is worthless:
    // it would also hold for a `run_inject` that never transitions the FSM at all.
    // A LIVE frame in the SAME harness must move it.
    let live = run_inject(&req(inject::InjectOrigin::Live, "obs-live"), &allow, &fsm, &dl, &dedup, TargetIntent::LiveForeground)
        .expect("a live frame produces a verdict");
    assert_eq!(live["error"], serde_json::json!(error_codes::INJECT_FOCUS_LOST));
    assert!(
        !matches!(
            fsm.lock().unwrap().state(),
            FocusState::SpeakingLocked { .. }
        ),
        "the live frame must reach the pipeline, or \"deferred did not\" proves nothing"
    );
}

/// §A-1 rows 3+4 — the two branches that must KEEP `None`, asserted where they are
/// decided. The RV-83 replay is reachable from here; the admission refusal lives in
/// client.rs and is pinned by row_transit_tests.rs's refusal test plus the frame
/// shape in wire_tests.rs.
#[test]
fn a_disk_ledger_replay_never_re_claims_a_window_it_did_not_observe() {
    let (allow, fsm, dl, _unused) = locked_env();
    let r = req(inject::InjectOrigin::Live, "rv83");
    let rid = r.request_id.clone().unwrap();
    // Seed the ON-DISK ledger exactly the way a prior process life does — two
    // separate `InjectDeduper`s over one file, which is the production shape
    // (`socket::client::connect` builds a fresh one per session). See the RV-83
    // block in dedup_tests.rs.
    let path = std::env::temp_dir().join(format!("flowmic-ij01-ledger-{}.json", uuid::Uuid::new_v4()));
    {
        let mut prior_life = InjectDeduper::load_spec_default(path.clone());
        prior_life.record(
            &r.source,
            Some(&rid),
            &r.text,
            &serde_json::json!({ "ok": true, "mode": "sendinput", "request_id": rid }),
            0,
        );
    }
    let dedup = Mutex::new(InjectDeduper::load_spec_default(path.clone()));
    let out = run_inject(&r, &allow, &fsm, &dl, &dedup, TargetIntent::LiveForeground).expect("a replay answers");
    assert_eq!(out["ok"], serde_json::json!(true), "precondition: this IS the replay branch");
    assert_eq!(out["mode"], serde_json::json!("sendinput"));
    // 🔴 A window WAS resolvable in this harness (the FSM is locked onto notepad),
    // so an implementation that reported "whatever is in front now" would pass a
    // weaker test. It must stay silent: this process never observed the window the
    // ORIGINAL delivery went to.
    assert!(out.get("focus_window").is_none());
    assert!(out.get("focus_evidence").is_none());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn the_no_target_exit_prints_no_fake_hwnd() {
    // There was no target, so there is no window id — printing a 0 would look
    // like an answer ("we tried hwnd 0") instead of "there was nothing to try".
    let l = ChordExit::NoTarget.line("tab", None, 1);
    assert!(l.contains("hwnd=-") || !l.contains("hwnd="), "no fabricated hwnd: {l}");
}

// ── 0.3.31: 「点了胶囊上的再注入，它注不进去」 ──────────────────────────────────
//
// owner 2026-08-24, on the capsule strip's re-inject icon: 「点了这个胶囊窗口之后，
// 它的焦点就是当前的这个胶囊窗口了，所以这个没办法注入到之前的这个窗口里面去」
// ("once you click the capsule window, the focus IS the capsule window, so it
// cannot inject into the window you were in before"). Measured on this machine at
// 2026-08-24T03:13:50.625Z, from a real click:
//
//   [self-focus] own window is foreground with NO editable focus (stale…) →
//   ok=false mode=cached err=INJECT_SELF_WINDOW_NO_INPUT; nothing typed
//
// These drive [`choose_target`] rather than [`resolve_inject_target`] because the
// latter reads the REAL foreground of whatever machine runs the suite, so it can
// only ever exercise the locked branch — and the branch this fixes is unlocked.

/// `(hwnd, window_title, process_name)` — the shape every CONSUMER wants.
fn consumer(h: u64, title: &str, app: &str) -> Option<(u64, String, String)> {
    Some((h, title.to_string(), app.to_string()))
}
/// `(hwnd, app_name, window_title)` — the shape the FSM's sidecar STORES.
fn sidecar(h: u64, app: &str, title: &str) -> Option<(u64, String, String)> {
    Some((h, app.to_string(), title.to_string()))
}

#[test]
fn a_click_on_our_own_window_aims_at_the_program_the_user_was_in_before() {
    // Unlocked + no live foreground == 「前台是 FlowMic 自己」, because
    // `current_foreground_target` answers None for our own windows by design.
    let out = choose_target(
        None,
        None,
        sidecar(0x320872, "Cursor", "flowmic-app - Cursor"),
        TargetIntent::BeforeTheClick,
    );
    // 🔴 BOTH HALVES NAMED. The sidecar stores (hwnd, app, title) and this
    // function returns (hwnd, title, app); the swap COMPILES (three Strings) and
    // would only ever show up as a forensic line reading "flowmic-app - Cursor:Cursor".
    let (h, title, app) = out.expect("the window they were in before IS the target");
    assert_eq!(h, 0x320872);
    assert_eq!(title, "flowmic-app - Cursor", "slot 2 is the WINDOW TITLE");
    assert_eq!(app, "Cursor", "slot 3 is the PROCESS NAME");
}

#[test]
fn the_same_inputs_from_a_wire_frame_still_have_no_destination() {
    // 🔴 REVERSE CONTROL FOR THE WHOLE CARD. Identical inputs, other intent. If
    // this ever returns Some, the fallback has leaked onto the path where 「前台是
    // FlowMic」 genuinely means 「没有目的地」 — the phone would start typing into a
    // window the user is not looking at, which is a different product.
    assert_eq!(
        choose_target(
            None,
            None,
            sidecar(0x320872, "Cursor", "flowmic-app - Cursor"),
            TargetIntent::LiveForeground,
        ),
        None,
    );
}

#[test]
fn a_live_foreground_is_never_overridden_by_the_sidecar() {
    // The fallback is for 「前台是我们自己」 ONLY. A real external foreground is the
    // answer to the question a click asks, too — the user clicked us from THERE.
    // Reading the sidecar first would resurrect a window they have since left.
    for intent in [TargetIntent::LiveForeground, TargetIntent::BeforeTheClick] {
        let out = choose_target(
            None,
            consumer(0x1F00D, "Notepad - a.txt", "notepad"),
            sidecar(0x320872, "Cursor", "flowmic-app - Cursor"),
            intent,
        );
        assert_eq!(out.unwrap().2, "notepad", "{intent:?}");
    }
}

#[test]
fn the_speaking_lock_still_beats_both_under_either_intent() {
    // F-203 / ruling 2 untouched: a mid-utterance switch must not re-target, and
    // that outranks everything this card adds.
    for intent in [TargetIntent::LiveForeground, TargetIntent::BeforeTheClick] {
        let out = choose_target(
            consumer(0xAAA, "locked title", "locked-app"),
            consumer(0xBBB, "live title", "live-app"),
            sidecar(0xCCC, "side-app", "side title"),
            intent,
        );
        assert_eq!(out.unwrap().0, 0xAAA, "{intent:?}");
    }
}

#[test]
fn with_nothing_ever_recorded_there_is_still_no_destination() {
    // A machine where FlowMic has been in front since launch. There is no window
    // to name, and inventing one is the forbidden direction of 没有静默失败.
    assert_eq!(choose_target(None, None, None, TargetIntent::BeforeTheClick), None);
}

#[test]
fn no_wire_path_can_ask_for_the_before_the_click_intent() {
    // The type system already makes this true — the intent is a PARAMETER of
    // run_inject, not a field of InjectRequest, so there is no key for a phone to
    // send. This pins the other half: that no socket CALL SITE hands it over.
    // (`local_inject.rs` is the one legitimate producer and is excluded.)
    let wire_side = include_str!("client.rs");
    assert!(
        wire_side.contains("TargetIntent::LiveForeground"),
        "control: the socket path must still pass an intent at all",
    );
    assert!(
        !wire_side.contains("TargetIntent::BeforeTheClick"),
        "a frame must never be able to aim at the window behind our own",
    );
    assert!(
        include_str!("local_inject.rs").contains("TargetIntent::BeforeTheClick"),
        "control: the local re-inject really is the producer",
    );
}
