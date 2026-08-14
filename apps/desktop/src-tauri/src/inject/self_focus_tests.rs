// Tests for inject/self_focus.rs, split out under `#[path]` for the 800-line src
// cap (the same shape pipeline_tests.rs uses).
//
// Everything here drives [`decide`] — the pure decision — so not one assertion
// depends on which window happened to be in front of the machine running the
// suite. The Win32 half (`live_foreground`) is two documented reads with no
// branching worth faking; what it feeds is asserted below in every combination.

use super::*;

const OURS: u64 = 0xA1;
const OTHER_OF_OURS: u64 = 0xB2;

fn fresh(hwnd: u64, editable: bool, now: Instant) -> Option<StampedReport> {
    Some(StampedReport {
        report: SelfFocusReport { hwnd, editable },
        at: now,
    })
}

#[test]
fn a_focused_input_in_our_foreground_window_is_typed_into() {
    // owner's 2026-08-02 ruling, positive case:「光标定位到这里我说的话肯定能注入」
    // ("if the cursor is positioned here, what I say should definitely be able to be injected").
    let now = Instant::now();
    assert_eq!(
        decide(fresh(OURS, true, now), now, true, OURS),
        SelfFocusVerdict::Editable(OURS)
    );
}

#[test]
fn our_foreground_window_with_no_editable_focus_is_a_named_no_input() {
    // owner, same ruling, other half:「自家窗口前台但无输入框聚焦 ⇒ 未注入·已缓存」
    // ("our own window is foreground but no input box has focus ⇒ not injected · cached") —
    // and it says WHICH of the four reasons, so the log can tell 「用户没点进输入框」
    // ("the user never clicked into an input box")
    // apart from 「渲染进程不答话」 ("the renderer process is not answering").
    let now = Instant::now();
    assert_eq!(
        decide(fresh(OURS, false, now), now, true, OURS),
        SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Reported)
    );
}

#[test]
fn another_app_in_front_means_this_module_has_nothing_to_say() {
    // 🔴 THE CROSS-CHECK. The report still SAYS `editable` — it is the live
    // foreground that refuses it. This is the branch that makes 「the user clicked away」
    // self-correcting with no event of any kind.
    let now = Instant::now();
    assert_eq!(
        decide(fresh(OURS, true, now), now, false, 0x9999),
        SelfFocusVerdict::NotOurWindow
    );
}

#[test]
fn a_zero_foreground_is_not_our_window_even_if_the_flag_says_ours() {
    // Lock screen / no foreground at all. `ours=true` with hwnd 0 is a state the OS
    // read cannot produce, and the guard is here so a future refactor of
    // `live_foreground` cannot smuggle 「没有前台」 ("there is no foreground") in as 「前台是我们」 ("the foreground is us").
    let now = Instant::now();
    assert_eq!(
        decide(fresh(OURS, true, now), now, true, 0),
        SelfFocusVerdict::NotOurWindow
    );
}

#[test]
fn no_report_at_all_degrades_to_cached_never_to_typing() {
    // 🔴 THE FAILURE DIRECTION, asserted rather than commented. A build whose
    // reporter is not wired must behave exactly like 0.2.48 did — not injected · cached —
    // and must NOT type the user's sentence into a window with no text field.
    let now = Instant::now();
    assert_eq!(
        decide(None, now, true, OURS),
        SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Absent)
    );
}

#[test]
fn a_report_older_than_the_ttl_stops_being_believed() {
    // The one case the live cross-check cannot cover: our window stayed in front
    // while the renderer stopped answering, so focus moved and nobody told us.
    let at = Instant::now();
    let now = at + SELF_FOCUS_TTL + Duration::from_millis(1);
    assert_eq!(
        decide(fresh(OURS, true, at), now, true, OURS),
        SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Stale)
    );
    // …and one instant BEFORE the boundary it is still believed, so the TTL is a
    // real boundary and not an accidental always-stale.
    let just_inside = at + SELF_FOCUS_TTL;
    assert_eq!(
        decide(fresh(OURS, true, at), just_inside, true, OURS),
        SelfFocusVerdict::Editable(OURS)
    );
}

#[test]
fn a_report_about_a_different_flowmic_window_proves_nothing_about_this_one() {
    // The capsule pushing 「我有输入焦点」 ("I have input focus") must not unlock typing into the MAIN
    // window. One window's DOM focus is not another's.
    let now = Instant::now();
    assert_eq!(
        decide(fresh(OTHER_OF_OURS, true, now), now, true, OURS),
        SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::OtherWindow)
    );
}

#[test]
fn the_four_no_input_causes_are_distinguishable_in_the_log() {
    // Same UI answer, four different root-causing answers. Two causes that print the same
    // words are one cause as far as a forensic log is concerned.
    let all = [
        NoInputEvidence::Reported,
        NoInputEvidence::Stale,
        NoInputEvidence::Absent,
        NoInputEvidence::OtherWindow,
    ];
    for (i, a) in all.iter().enumerate() {
        for b in all.iter().skip(i + 1) {
            assert_ne!(a.tag(), b.tag(), "two evidence variants print the same token");
        }
        assert!(a.tag().len() > 5, "a one-word token answers nothing: {}", a.tag());
    }
}

#[test]
fn the_global_slot_round_trips_and_clears() {
    // The push path (`record_report`) and the read path (`stored_report`) are the
    // two halves of the Tauri command's contract; a command that stored nothing
    // would leave `decide` permanently on its Absent branch and the feature would
    // be a façade with a green suite.
    clear_report();
    assert_eq!(stored_report(), None);
    record_report(OURS, true);
    let stored = stored_report().expect("record_report must store something");
    assert_eq!(stored.report.hwnd, OURS);
    assert!(stored.report.editable);
    // Last writer wins — the second push is the answer, not the first.
    record_report(OTHER_OF_OURS, false);
    let second = stored_report().expect("still stored");
    assert_eq!(second.report.hwnd, OTHER_OF_OURS);
    assert!(!second.report.editable);
    clear_report();
    assert_eq!(stored_report(), None);
}

#[test]
fn the_seams_default_answer_is_the_one_that_changes_nothing() {
    // Every caller with no WebView (golden example, smokes, cargo test) uses this,
    // and it must be the value that leaves the cross-process pipeline untouched.
    assert_eq!(never_ours(), SelfFocusVerdict::NotOurWindow);
}
