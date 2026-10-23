// Tests for `uipi.rs`. The judgement is pure and is tested as a table on every
// platform; the hook position is tested through the real pipeline with the
// test seam; the real Win32 reader is smoke-tested only on what every Windows
// machine can answer the same way (its own token, and a window handle of 0).

use super::*;

const LOW: u32 = 0x1000;
const MEDIUM: u32 = 0x2000;
const MEDIUM_PLUS: u32 = 0x2100;
const HIGH: u32 = 0x3000;
const SYSTEM: u32 = 0x4000;

fn facts(sender: u32, target: u32) -> UipiFacts {
    UipiFacts {
        sender: IntegrityReading::Rid(sender),
        sender_ui_access: Some(false),
        target: IntegrityReading::Rid(target),
        target_pid: 42,
    }
}

/// 🔴 The measured case, pinned verbatim: a Medium FlowMic and a High target
/// (spike report §3.2, NC3 paste ×3 + NC4 typing ×2, all `ok=true` and an
/// empty box). This is the row the whole module exists for.
#[test]
fn the_measured_medium_to_high_case_blocks_input() {
    assert_eq!(
        uipi_verdict(facts(MEDIUM, HIGH)),
        UipiVerdict::TargetAbove {
            sender: MEDIUM,
            target: HIGH
        }
    );
    assert!(uipi_verdict(facts(MEDIUM, HIGH)).blocks_input());
}

/// Every strictly-higher target blocks, including the less common rungs.
#[test]
fn any_strictly_higher_target_blocks_input() {
    for (s, t) in [
        (MEDIUM, HIGH),
        (MEDIUM, SYSTEM),
        (HIGH, SYSTEM),
        (LOW, MEDIUM),
        (MEDIUM, MEDIUM_PLUS),
    ] {
        assert!(
            uipi_verdict(facts(s, t)).blocks_input(),
            "sender=0x{s:x} target=0x{t:x} must block"
        );
    }
}

/// 🔴 The no-regression half: equal or lower integrity MUST proceed. The
/// spike measured High→High and Medium→Medium at 20/20; a refusal there would
/// break the product for every user, owner included (all-High machine).
#[test]
fn equal_or_lower_targets_are_deliverable() {
    for (s, t) in [
        (MEDIUM, MEDIUM),
        (HIGH, HIGH),
        (SYSTEM, SYSTEM),
        (HIGH, MEDIUM),
        (SYSTEM, HIGH),
        (MEDIUM_PLUS, MEDIUM),
    ] {
        assert_eq!(
            uipi_verdict(facts(s, t)),
            UipiVerdict::Deliverable,
            "sender=0x{s:x} target=0x{t:x}"
        );
    }
}

/// A UIAccess sender is exempt from UIPI, so even a higher target proceeds.
#[test]
fn ui_access_is_exempt() {
    let mut f = facts(MEDIUM, HIGH);
    f.sender_ui_access = Some(true);
    assert_eq!(uipi_verdict(f), UipiVerdict::UiAccess);
    assert!(!uipi_verdict(f).blocks_input());
}

/// An UNREADABLE UIAccess flag is not a reason to proceed past a measured
/// higher target: it only removes an exemption we could not prove.
#[test]
fn an_unreadable_ui_access_flag_does_not_hide_a_higher_target() {
    let mut f = facts(MEDIUM, HIGH);
    f.sender_ui_access = None;
    assert!(uipi_verdict(f).blocks_input());
}

/// 🔴 Unknown never blocks (no false refusals), and the verdict carries WHICH
/// read failed so the forensic line can tell the field cases apart.
#[test]
fn an_unknown_reading_never_blocks_and_keeps_its_reason() {
    let mut f = facts(MEDIUM, HIGH);
    f.target = IntegrityReading::Unknown("open_process_denied");
    assert_eq!(uipi_verdict(f), UipiVerdict::Unknown("open_process_denied"));
    assert!(!uipi_verdict(f).blocks_input());

    let mut g = facts(MEDIUM, HIGH);
    g.sender = IntegrityReading::Unknown("open_token_denied");
    assert_eq!(uipi_verdict(g), UipiVerdict::Unknown("open_token_denied"));
    assert!(!uipi_verdict(g).blocks_input());
}

/// The hook is consulted with the window the frame is about to be typed into,
/// and BEFORE Stage 1 — so the day it refuses, the refusal takes no foreground
/// and touches no clipboard.
#[test]
fn the_text_pipeline_judges_the_locked_window_before_stage_1() {
    thread_local! {
        static SEEN_AT_SWITCH: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    }
    fn switch_records_order(_h: u64) -> bool {
        let seen = take_seen();
        SEEN_AT_SWITCH.with(|c| c.set(Some(seen.len())));
        // Put them back for the assertion below.
        for h in seen {
            TEST_SEEN.with(|s| s.borrow_mut().push(h));
        }
        false // ⇒ Stage 1 refuses; nothing is ever typed by this test.
    }
    let _ = take_seen();
    let out = crate::inject::inject_text("hello", Some(0x1234), Some("notepad"), switch_records_order);
    assert_eq!(take_seen(), vec![0x1234], "the locked window is the one judged");
    assert_eq!(
        SEEN_AT_SWITCH.with(|c| c.get()),
        Some(1),
        "judged before Stage 1 took the foreground"
    );
    // The fake switcher refused, so this frame ended at Stage 1, as before.
    assert_eq!(
        out.error_code,
        Some(crate::error_codes::INJECT_FOCUS_LOST)
    );
}

/// No target ⇒ nothing to judge (Stage 1 answers FOCUS_LOST as before).
#[test]
fn no_locked_window_means_nothing_is_judged() {
    let _ = take_seen();
    let _ = crate::inject::inject_text("hello", None, Some("notepad"), |_| false);
    assert!(take_seen().is_empty());
}

/// Our own window is one process with one integrity: not asked.
#[test]
fn our_own_window_is_not_judged() {
    let _ = take_seen();
    let recorded = crate::inject::delivery_test_sink::recording(|| {
        let _ = crate::inject::pipeline::inject_text_with_probe(
            "hello",
            None,
            Some("flowmic"),
            |_| true,
            || crate::inject::FocusInputState::Input,
            || crate::inject::SelfFocusVerdict::Editable(77),
        );
    });
    assert_eq!(recorded, vec!["hello".to_string()], "the frame still reached the output");
    assert!(take_seen().is_empty(), "our own window must not be judged");
}

/// The picture path takes the same hook (a pasted picture is a Ctrl+V, which
/// UIPI drops the same way). Gated like the pipeline's own image tests: only
/// these two platforms can build a clipboard format table.
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
fn the_image_pipeline_judges_the_locked_window_before_stage_1() {
    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let _ = take_seen();
    let out = crate::inject::inject_image(PNG_1X1, "image/png", Some(0x5678), |_| false);
    assert_eq!(take_seen(), vec![0x5678]);
    assert_eq!(out.error_code, Some(crate::error_codes::INJECT_FOCUS_LOST));
}

/// 🔴 The hook refuses the measured case by name. This test used to be
/// `the_hook_does_not_refuse_until_its_code_is_registered` (asserting `None`);
/// it was changed on purpose the day `INJECT_TARGET_ELEVATED` was registered.
#[test]
fn the_hook_refuses_a_higher_target_by_name_as_cached() {
    let _g = with_test_facts(facts(MEDIUM, HIGH));
    let out = uipi_preflight(0x1234).expect("a Medium sender aimed at a High window must be refused");
    assert!(!out.ok);
    assert_eq!(out.mode, crate::inject::InjectMode::Cached, "delivered, not injected");
    assert_eq!(out.error_code, Some(crate::error_codes::INJECT_TARGET_ELEVATED));
    assert!(out.focus_evidence.is_none(), "the focus was never read: nothing to claim");
    let _ = take_seen();
}

/// 🔴 The no-false-refusal half of the same switch: only `TargetAbove` refuses.
/// An unreadable level (another account's process, e.g. SYSTEM), equal or lower
/// integrity, and a UIAccess sender all proceed exactly as before the switch.
#[test]
fn only_a_higher_target_is_refused() {
    let mut unknown = facts(MEDIUM, HIGH);
    unknown.target = IntegrityReading::Unknown("open_process_denied");
    let mut ui_access = facts(MEDIUM, HIGH);
    ui_access.sender_ui_access = Some(true);
    for f in [facts(MEDIUM, MEDIUM), facts(HIGH, HIGH), facts(HIGH, MEDIUM), unknown, ui_access] {
        let _g = with_test_facts(f);
        assert_eq!(uipi_preflight(0x1234), None, "{f:?} must not be refused");
        let _ = take_seen();
    }
    assert_eq!(refusal_for(UipiVerdict::Deliverable), None);
    assert_eq!(refusal_for(UipiVerdict::UiAccess), None);
    assert_eq!(refusal_for(UipiVerdict::Unknown("no_window_process")), None);
}

/// 🔴 The refusal takes NO foreground and sends NO keystroke: the text pipeline
/// returns the refusal before Stage 1 ever calls the focus switcher, and the
/// delivery sink records nothing. (The clipboard is only ever touched in Stage
/// 2/3, after the switcher; a switcher that is never called proves the frame
/// never got there.)
#[test]
fn a_refused_text_frame_never_takes_the_foreground_or_reaches_the_output() {
    let _g = with_test_facts(facts(MEDIUM, HIGH));
    let _ = take_seen();
    thread_local! {
        static SWITCHED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    fn switcher(_h: u64) -> bool {
        SWITCHED.with(|c| c.set(true));
        true
    }
    // (a) The real composition with only the two probes injected: our switcher
    // is the one Stage 1 would call.
    let out = crate::inject::pipeline::inject_text_with_probe(
        "hello",
        Some(0x1234),
        Some("pwsh"),
        switcher,
        || crate::inject::FocusInputState::Input,
        crate::inject::self_focus::never_ours,
    );
    assert_eq!(out.error_code, Some(crate::error_codes::INJECT_TARGET_ELEVATED));
    assert!(!SWITCHED.with(|c| c.get()), "Stage 1 must not run: no foreground switch");
    assert_eq!(take_seen(), vec![0x1234]);

    // (b) The output-recording harness (it locks its own window handle, 1, and
    // fakes a switcher that always succeeds): the refused frame never reaches
    // the output, while the same harness with equal integrity does (positive
    // control — an empty recording must mean "refused", not "harness blind").
    let mut refused = None;
    let recorded = crate::inject::delivery_test_sink::recording(|| {
        refused = Some(crate::inject::inject_text("hello", Some(0x1234), Some("pwsh"), switcher));
    });
    assert_eq!(refused.unwrap().error_code, Some(crate::error_codes::INJECT_TARGET_ELEVATED));
    assert!(recorded.is_empty(), "nothing may reach the output: {recorded:?}");
    assert_eq!(take_seen(), vec![1]);
    drop(_g);
    let control = crate::inject::delivery_test_sink::recording(|| {
        let _ = crate::inject::inject_text("hello", Some(0x1234), Some("pwsh"), switcher);
    });
    assert_eq!(control, vec!["hello".to_string()], "equal integrity must still reach the output");
    let _ = take_seen();
}

/// The picture path refuses the same way, before Stage 1.
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
fn a_refused_picture_never_takes_the_foreground() {
    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let _g = with_test_facts(facts(MEDIUM, HIGH));
    let _ = take_seen();
    let out = crate::inject::inject_image(PNG_1X1, "image/png", Some(0x5678), |_| {
        panic!("Stage 1 must not run for a refused picture")
    });
    assert_eq!(out.error_code, Some(crate::error_codes::INJECT_TARGET_ELEVATED));
    assert_eq!(out.mode, crate::inject::InjectMode::Cached);
    assert_eq!(take_seen(), vec![0x5678]);
}

/// The real reader, on the two answers every Windows machine gives alike: a
/// process can always read its OWN integrity, and window handle 0 has no
/// owning process.
#[cfg(windows)]
#[test]
fn the_real_reader_reads_our_own_integrity_and_names_a_missing_window() {
    let f = win::read_facts(0);
    assert!(
        matches!(f.sender, IntegrityReading::Rid(r) if r >= LOW),
        "own integrity must be readable: {f:?}"
    );
    assert_eq!(f.target, IntegrityReading::Unknown("no_window_process"));
    assert_eq!(f.target_pid, 0);
}
