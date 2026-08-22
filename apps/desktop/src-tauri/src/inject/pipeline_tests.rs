// Tests for inject/pipeline.rs, split out under `#[path]` for the 800-line src
// cap (the same shape socket/client.rs uses for client_tests.rs). Nothing here
// changed in the move — this is the pipeline's own contract, kept beside it.

use super::*;
// The 800-line split moved the two PRE-pipeline gates to `preflight.rs`; their
// contracts are still asserted from here because what they have to be right about
// is their COMPOSITION with the pipeline (「a function was written but nobody calls it」 is this repo's #1
// historical bug class, and the gate's own file cannot prove the pipeline calls it).
use crate::inject::preflight::{deferred_outcome, self_window_no_input, InjectOrigin};
use crate::inject::self_focus::{NoInputEvidence, SelfFocusVerdict};

fn switch_ok(_h: u64) -> bool {
    true
}
fn switch_fail(_h: u64) -> bool {
    false
}

// A switcher that COUNTS. `FocusSwitcher` is a bare `fn` pointer with no
// user-data slot, so the counter is a thread-local rather than a capture — which
// is also what keeps it correct under `cargo test`'s parallelism (the same reason
// the synthetic-input test seam is thread-local; see preflight.rs).
thread_local! {
    static SWITCH_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn switch_counting(_h: u64) -> bool {
    SWITCH_CALLS.with(|c| c.set(c.get() + 1));
    true
}
fn switch_calls() -> usize {
    SWITCH_CALLS.with(|c| c.get())
}
fn reset_switch_calls() {
    SWITCH_CALLS.with(|c| c.set(0));
}

#[test]
fn empty_text_is_ok_before_any_focus_check() {
    let out = inject_text("", None, None, switch_fail);
    assert!(out.ok, "empty text needs no target");
    assert_eq!(out.mode, InjectMode::SendInput);
}

#[test]
fn no_target_hwnd_is_cached_not_silent() {
    let out = inject_text("hello", None, None, switch_ok);
    assert!(!out.ok);
    assert_eq!(out.mode, InjectMode::Cached);
    assert_eq!(out.error_code, Some(error_codes::INJECT_FOCUS_LOST));
    assert!(out.error_message.is_some(), "cached outcome carries a reason");
}

#[test]
fn zero_hwnd_is_treated_as_no_target() {
    let out = inject_text("hello", Some(0), None, switch_ok);
    assert_eq!(out.mode, InjectMode::Cached);
    assert_eq!(out.error_code, Some(error_codes::INJECT_FOCUS_LOST));
}

#[test]
fn focus_switch_failure_is_cached() {
    let out = inject_text("hello", Some(0x1234), Some("notepad"), switch_fail);
    assert!(!out.ok);
    assert_eq!(out.mode, InjectMode::Cached);
    assert_eq!(out.error_code, Some(error_codes::INJECT_FOCUS_LOST));
}

#[test]
fn wire_tokens_match_the_protocol_enum() {
    assert_eq!(InjectMode::SendInput.wire(), "sendinput");
    assert_eq!(InjectMode::Clipboard.wire(), "clipboard");
    assert_eq!(InjectMode::Cached.wire(), "cached");
}

#[test]
fn over_length_text_is_rejected_not_truncated() {
    let huge = "x".repeat(INJECT_TEXT_MAX_CHARS + 1);
    let out = inject_text(&huge, Some(0x10), Some("notepad"), switch_ok);
    assert!(!out.ok, "over-cap text must be rejected");
    assert_eq!(out.mode, InjectMode::SendInput, "non-cached → server maps to failed");
    assert_eq!(out.error_code, Some(error_codes::INJECT_TARGET_INVALID));
    // At the cap it is still accepted (would proceed to Stage 1 focus).
    let at_cap = "x".repeat(INJECT_TEXT_MAX_CHARS);
    let out2 = inject_text(&at_cap, None, None, switch_ok);
    assert_ne!(out2.error_code, Some(error_codes::INJECT_TARGET_INVALID));
}

// 2026-07-30 (design §3 ⚠️): the delayed-render receipt is no longer the ok/fail
// gate for the TEXT paste either — it shares the very same machinery as the
// picture path, so it gets the very same rule. What `injected` claims is that the
// paste was PERFORMED at a focus Stage 1/1b had already established; whether the
// target app took it is the target's business. The receipt still goes to forensic.
//
// This inverts the old `unconfirmed_clipboard_paste_is_failed_never_injected`
// assertion, which is worth stating plainly rather than quietly deleting: that
// test encoded owner's 07-28 rule 「未确认，即未注入」 ("unconfirmed means not
// injected"), and owner's 07-30 ruling
// narrowed what 「注入」 ("injected") asserts so the rule has nothing left to bite on.
#[test]
fn an_unconfirmed_clipboard_paste_is_still_a_performed_delivery() {
    let store = AppLearningStore::new();
    let out = map_clipboard_outcome(
        Ok(PasteOutcome { confirmed: false, ..Default::default() }),
        None,
        &store,
        false,
    );
    assert!(out.ok, "the paste was performed at a verified focus");
    assert_eq!(out.mode, InjectMode::Clipboard);
    assert_eq!(
        out.error_code, None,
        "an unconsumed paste is not a clipboard FAILURE — nothing of ours errored"
    );
}

// RV-48 (2026-07-30) — this assertion is INVERTED, and it is a semantic fix, not a
// relaxed gate. It used to require `INJECT_SENDINPUT_FAIL` on an `ok:true` outcome,
// on the grounds (stated in the code it guarded) that the UI needed it to tell a
// paste from a typed delivery. Grepped across desktop / phone / server: no reader
// exists — the desktop only reads the wire's `error` inside `if (!ok)`, the phone
// maps status from `ok`+`mode`, the server from `ok`+`mode`. A delivery must not
// carry a failure code, `mode` already answers 「which path」, and 「why this path」
// is now on the forensic line (`sendinput=…`) where diagnostics belong.
#[test]
fn a_delivered_clipboard_paste_carries_no_error_code() {
    let store = AppLearningStore::new();
    for skipped_sendinput in [false, true] {
        let out = map_clipboard_outcome(
            Ok(PasteOutcome { confirmed: true, ..Default::default() }),
            None,
            &store,
            skipped_sendinput,
        );
        assert!(out.ok, "confirmed consumption is a real delivery");
        assert_eq!(out.mode, InjectMode::Clipboard, "mode is what says 「by paste」");
        assert_eq!(
            out.error_code, None,
            "an outcome we call a delivery must not also carry a failure code"
        );
    }
}

// RV-44 put the WINDOW into this sentence, because a measurement without its
// window is an unfalsifiable claim, and pinned the number to the constant so the
// log cannot outlive a change to it. Both still hold.
//
// 🔴 2026-08-22 TOOK THE WORD 「consumed」 OUT, AND THIS TEST NOW PINS ITS ABSENCE.
// RV-44's own assertions were `contains("consumed=false")` / `contains("consumed=true")`
// — i.e. this test REQUIRED the log to say the one thing that was measured to be
// untrue. `WM_RENDERFORMAT` arrives 13ms after Ctrl+V whether or not the target is
// in any state to paste; in the reproduction it arrived identically in the run
// that inserted our text and the run that inserted the user's old clipboard. So
// 「consumed」 was never what the flag meant, and a test asserting that word was
// holding the wrong sentence in place — the 0.2.52 shape (a reverse control that
// pins the defect as the spec), one more time.
//
// What the sentence must do now: name the hold window, and never claim anything
// about what the target did with the bytes. `LandingEvidence` owns that claim.
#[cfg(not(target_os = "macos"))]
#[test]
fn the_receipt_line_names_its_window_and_never_claims_the_target_inserted_anything() {
    for confirmed in [true, false] {
        let phrase = receipt_phrase(confirmed);
        assert!(
            !phrase.contains("consumed"),
            "「consumed」 is the word that was measured wrong; it must not come back: {phrase}"
        );
    }
    // ⚠️ This used to also assert `!contains("inserted")`, and it failed against
    // a sentence that reads 「NOT evidence the target inserted it」 — i.e. the
    // assertion could not tell a CLAIM from its DENIAL. Substring bans are a bad
    // instrument for 「does this sentence assert X」; the served arm therefore has
    // to carry the disclaimer explicitly instead.
    assert!(
        receipt_phrase(true).contains("NOT evidence"),
        "a served fetch must say out loud that it is not evidence of a landing: {}",
        receipt_phrase(true)
    );
    let none = receipt_phrase(false);
    assert!(
        none.contains(&format!("{}ms", PASTE_HOLD.as_millis())),
        "the window we really held for must be in the sentence: {none}"
    );
    let served = receipt_phrase(true);
    assert!(
        served.contains("served"),
        "a fetch we DID answer is reported as a fetch: {served}"
    );
}

/// The macOS sibling of the test above, and it asserts the OPPOSITE property for
/// the same reason RV-44 wrote that one: a sentence must not read as a measurement
/// it did not make.
///
/// On Windows the danger is 「consumed=false」 being read as 「the target refused」,
/// so the WINDOW gets named. Here the danger is worse — there is no window and no
/// observation at all — so the sentence must (a) still name the hold, because the
/// user's pasteboard really was held that long, and (b) never use the word
/// 「consumed」, which is what would turn a structural n/a back into a verdict about
/// the target.
#[cfg(target_os = "macos")]
#[test]
fn the_macos_receipt_line_never_claims_an_observation_it_could_not_make() {
    let phrase = receipt_phrase(false);
    assert!(phrase.contains("n/a on macOS"), "{phrase}");
    assert!(
        phrase.contains(&format!("{}ms", PASTE_HOLD.as_millis())),
        "the pasteboard really was held this long; the number is a fact: {phrase}"
    );
    assert!(
        !phrase.contains("consumed"),
        "「consumed」 is the word that would make this read as a measurement: {phrase}"
    );
    // An invented `true` must be loud rather than silent — it cannot come from the
    // production path (pasteboard.rs pins `confirmed:false`), so if it ever shows
    // up in a log, the log has to say that is impossible.
    assert!(receipt_phrase(true).contains("IMPOSSIBLE"));
}

#[test]
fn clipboard_error_is_failed() {
    // The reverse assertion for the de-gating above: a real Win32 error is OURS,
    // knowably did not happen, and must NOT be swept into the new ok=true branch.
    let store = AppLearningStore::new();
    let out = map_clipboard_outcome(Err(InjectError::AppRejected), None, &store, true);
    assert!(!out.ok);
    assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
    assert_ne!(out.mode, InjectMode::Cached, "an error is failed, not re-deliverable");
}

// NOTE: the ok SendInput path drives real Win32 and is exercised by the
// guarded golden-path run against a sacrificial window, not here — a
// headless host has no input desktop. The focus-lost/cached truth, the
// length cap, and the unconfirmed-clipboard truth ARE unit-provable above.

// ── R6 T-4 ②: the image path ────────────────────────────────────────────

/// The same real 2×2 RGBA PNG image.rs decodes, as canonical base64.
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMASUkJeJw9PL4AAAAASUVORK5CYII=";

#[test]
fn a_bad_image_payload_is_rejected_before_focus_is_ever_touched() {
    // switch_ok would succeed if we reached Stage 1 — proving the guard
    // runs FIRST means a malformed frame can never steal the foreground.
    for (b64, mime) in [
        ("not base64 at all", "image/png"),
        (PNG_B64, "image/gif"),
        (PNG_B64, "image/jpeg"), // real PNG bytes announced as JPEG
        ("QUJDRA==", "image/png"), // canonical base64, not a picture
    ] {
        let out = inject_image(b64, mime, Some(0x1234), switch_ok);
        assert!(!out.ok, "{mime}/{b64:.12} must not report a delivery");
        assert_eq!(out.error_code, Some(error_codes::INJECT_IMAGE_UNSUPPORTED));
        assert_ne!(out.mode, InjectMode::Cached, "non-cached → server maps to failed");
        assert!(
            out.error_message.as_deref().is_some_and(|m| !m.is_empty()),
            "every image rejection names its reason"
        );
    }
}

// ── Stage 1b: the TEXT path refuses; the PICTURE path only observes ─────
//
// owner 2026-07-27:「PC端在接收图片后，检测到如果是有焦点输入框」 ("after the PC
// receives a picture, detect whether there is a focused input box") gave both
// paths the same probe. v0.2.9 splits them again, because owner 2026-07-29
// hit the consequence:「图片仍然注入不到焦点输入框……旧项目是可以成功注入的」
// ("pictures still cannot be injected into the focused input box ... the old
// project could inject them successfully").
//
// 2026-07-30: the JUDGEMENT behind the text refusal changed (UIA → the two things
// provable out of process, see target_probe.rs), but the SPLIT is untouched: text
// still refuses a proven non-input site because stray characters fire single-key
// accelerators, and a picture still never refuses because a stray Ctrl+V does not.

fn probe_not_input() -> crate::inject::target_probe::FocusInputState {
    crate::inject::target_probe::FocusInputState::NotInput
}
fn probe_input() -> crate::inject::target_probe::FocusInputState {
    crate::inject::target_probe::FocusInputState::Input
}
fn probe_unknown() -> crate::inject::target_probe::FocusInputState {
    crate::inject::target_probe::FocusInputState::Unknown
}

// ── Stage-0 (self-window) fakes ──────────────────────────────────────────────
//
// A SECOND seam, never a flag on the first: the two probes answer different
// questions and have opposite defaults on an inconclusive reading. `self_never_ours`
// is what every pre-existing test passes, and it is the value that leaves the
// cross-process pipeline byte-for-byte as it was.
const SELF_HWND: u64 = 0x5E1F;
fn self_never_ours() -> SelfFocusVerdict {
    SelfFocusVerdict::NotOurWindow
}
fn self_editable() -> SelfFocusVerdict {
    SelfFocusVerdict::Editable(SELF_HWND)
}
fn self_no_input() -> SelfFocusVerdict {
    SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Reported)
}
fn self_absent() -> SelfFocusVerdict {
    SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Absent)
}

// ── 🔴 owner 2026-08-02 F1a: our own input box must be able to receive injection ─────────────────────────────

#[test]
fn a_focused_input_in_our_own_window_becomes_the_target() {
    // owner:「它本身就是 PC 端的一个窗口，光标定位到这里我说的话肯定能注入，这是非常
    // 正常的要求。」 ("It IS itself a window on the PC side; if the cursor is
    // positioned here, what I say should definitely be able to be injected — that
    // is a perfectly normal expectation.") Stage 0 is where that sentence lives.
    let verdict = self_window_stage0(None, self_editable);
    assert_eq!(
        verdict,
        Some(Ok(SELF_HWND)),
        "an editable focus in our own foreground window IS a target"
    );
}

#[test]
fn our_own_window_without_an_editable_focus_is_cached_by_its_own_name() {
    // The other half of the same ruling, and the THIRD cause of `cached`.
    // Asserted through the whole text pipeline, not just Stage 0: without the
    // composition this passes against an `inject_text_with_probe` that never calls
    // the probe — 「a function was written but nobody calls it」 is this repo's #1 historical bug class.
    let out = inject_text_with_probe("hello", None, None, switch_ok, probe_input, self_no_input);
    assert!(!out.ok, "nothing was typed, so nothing may be claimed");
    assert_eq!(out.mode, InjectMode::Cached, "投递成功了，只有注入没做成");
    assert_eq!(
        out.error_code,
        Some(error_codes::INJECT_SELF_WINDOW_NO_INPUT),
        "it must NOT come back as the generic Stage-1 focus loss — that is a \
         different cause with different advice"
    );
    assert!(out.error_message.is_some(), "a cached outcome carries its reason");
}

#[test]
fn stage0_runs_before_stage1_and_the_positive_control_proves_the_probe_is_consulted() {
    // 🔴 THE ORDERING, and its positive control in the same test. With
    // `self_never_ours` the very same frame resolves to Stage 1's INJECT_FOCUS_LOST
    // — so the assertion above cannot be satisfied by a pipeline that refuses
    // everything, and this one cannot be satisfied by a pipeline that never reaches
    // Stage 1. Both codes are reachable; which one comes back is decided by the
    // probe alone.
    let ours = inject_text_with_probe("hi", None, None, switch_ok, probe_input, self_no_input);
    let theirs = inject_text_with_probe("hi", None, None, switch_ok, probe_input, self_never_ours);
    assert_eq!(ours.error_code, Some(error_codes::INJECT_SELF_WINDOW_NO_INPUT));
    assert_eq!(theirs.error_code, Some(error_codes::INJECT_FOCUS_LOST));
    assert_ne!(
        ours.error_code, theirs.error_code,
        "the two situations must not answer with the same code"
    );
}

#[test]
fn a_speaking_lock_still_wins_over_our_own_window() {
    // 07 §3 / F-203, untouched: the user started speaking into Notepad and then
    // clicked into FlowMic. The sentence still belongs to Notepad. Stage 0 must not
    // even ASK the probe — `self_editable` would otherwise hijack the delivery.
    assert_eq!(
        self_window_stage0(Some(0x1234), self_editable),
        None,
        "a resolved target owns the frame; Stage 0 has no say"
    );
    // …and a zero hwnd is 「no target」, not 「a target of zero」 (same reading
    // `stage1_focus` has always had).
    assert_eq!(self_window_stage0(Some(0), self_editable), Some(Ok(SELF_HWND)));
}

#[test]
fn an_unwired_or_wedged_reporter_degrades_to_cached_never_to_typing() {
    // 🔴 THE FAILURE DIRECTION. A build whose reporter is missing, or a renderer
    // that stopped answering, must behave exactly like 0.2.48 did for this case —
    // not injected · cached — and must never type the user's sentence into a window with
    // no text field. (`Absent` and `Stale` are the two evidence variants for it.)
    let out = inject_text_with_probe("hello", None, None, switch_ok, probe_input, self_absent);
    assert_eq!(out.mode, InjectMode::Cached);
    assert_eq!(out.error_code, Some(error_codes::INJECT_SELF_WINDOW_NO_INPUT));
    assert!(!out.ok, "an unanswerable probe must never produce an `injected` claim");
}

#[test]
fn cached_now_has_three_causes_and_no_two_of_them_share_a_code() {
    // 🔴 doc 15 §2.5e-4, extended. Three causes, three DIFFERENT actions for the
    // user: ① click into an input box (we don't know which window) ② nothing you do to
    // the window helps, go re-inject from the PC timeline ③ click into FlowMic's own input box
    // (that window is right in front of you). They share
    // `mode:'cached'` (all three are re-injectable) and must never share a code.
    let no_focus = inject_text("hello", None, None, switch_ok);
    let deferred = deferred_outcome(InjectOrigin::Deferred).unwrap();
    let self_window = self_window_no_input(NoInputEvidence::Reported);
    let all = [&no_focus, &deferred, &self_window];
    for o in all {
        assert_eq!(o.mode, InjectMode::Cached, "all three ARE cached — that part is shared");
        assert!(!o.ok);
    }
    for (i, a) in all.iter().enumerate() {
        for b in all.iter().skip(i + 1) {
            assert_ne!(
                a.error_code, b.error_code,
                "two causes of one status must be distinguishable, or the UI cannot show \
                 them apart"
            );
        }
    }
    assert_eq!(no_focus.error_code, Some(error_codes::INJECT_FOCUS_LOST));
    assert_eq!(
        self_window.error_code,
        Some(error_codes::INJECT_SELF_WINDOW_NO_INPUT)
    );
}

// ── MAC-05: the synthetic-input gate is actually WIRED, and refuses first ────
//
// 🔴 These live here rather than in preflight.rs for the reason stated at the top
// of this file: `preflight`'s own tests can prove the JUDGEMENT, and only a
// composition test can prove the pipeline calls it. 「a function was written but
// nobody calls it」 is this
// repo's #1 historical bug class, and the gate is the one thing standing between a
// macOS user and 「两端全报已注入，字一个没进」 ("both ends report injected, but not a single character landed").
//
// ⚠️ THEY RUN ON EVERY PLATFORM, INCLUDING WINDOWS, AND THAT IS DELIBERATE — but
// it must not be misread. In PRODUCTION `synthetic_input_preflight()` is `None` on
// Windows by construction (no OS mode there swallows SendInput silently), so this
// refusal cannot occur on Windows. What these prove is the WIRING, and the wiring
// is worth guarding in the suite that actually runs on every commit.

#[test]
fn a_refused_synthetic_input_gate_ends_the_text_frame_before_stage_1() {
    use crate::error_codes::{INJECT_NO_ACCESSIBILITY, INJECT_SECURE_INPUT_ACTIVE};
    use crate::inject::preflight::{with_test_facts, SyntheticInputFacts};
    // ① no Accessibility permission
    {
        let _g = with_test_facts(SyntheticInputFacts {
            accessibility_trusted: false,
            secure_event_input: false,
        });
        reset_switch_calls();
        let out = inject_text("hello", Some(0x1234), Some("notepad"), switch_counting);
        assert!(!out.ok, "a keystroke the OS will discard is not a delivery");
        assert_eq!(out.mode, InjectMode::Cached);
        assert_eq!(out.error_code, Some(INJECT_NO_ACCESSIBILITY));
        // 🔴 The negative assertion that gives the gate its value: refusing must
        // cost the user NOTHING. No foreground was taken for an act that never
        // happened — the same rule `deferred_outcome` is built on.
        assert_eq!(
            switch_calls(),
            0,
            "a refusal must not steal the foreground on its way to not typing"
        );
    }
    // ② secure event input
    {
        let _g = with_test_facts(SyntheticInputFacts {
            accessibility_trusted: true,
            secure_event_input: true,
        });
        reset_switch_calls();
        let out = inject_text("hello", Some(0x1234), Some("notepad"), switch_counting);
        assert_eq!(out.error_code, Some(INJECT_SECURE_INPUT_ACTIVE));
        assert_eq!(switch_calls(), 0);
    }
    // ③ POSITIVE CONTROL. Without this the two assertions above would pass just as
    // well against a pipeline that never calls the switcher at all — 「zero」 has to
    // be shown to be a zero the gate produced.
    reset_switch_calls();
    let _ = inject_text("hello", Some(0x1234), Some("notepad"), switch_counting);
    assert!(
        switch_calls() > 0,
        "with a deliverable gate the frame must reach Stage 1 — otherwise the zeros above \
         prove nothing about the gate"
    );
}

// The picture path takes the same gate, and it must ALSO refuse before Stage 1.
// Gated to the two platforms that can build a format table at all, for the same
// reason as `a_valid_image_with_no_target_is_cached_not_failed`.
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
fn a_refused_synthetic_input_gate_ends_the_image_frame_before_stage_1() {
    use crate::error_codes::INJECT_NO_ACCESSIBILITY;
    use crate::inject::preflight::{with_test_facts, SyntheticInputFacts};
    {
        let _g = with_test_facts(SyntheticInputFacts {
            accessibility_trusted: false,
            secure_event_input: false,
        });
        reset_switch_calls();
        let out = inject_image(PNG_B64, "image/png", Some(0x1234), switch_counting);
        assert!(!out.ok);
        assert_eq!(out.mode, InjectMode::Cached);
        assert_eq!(out.error_code, Some(INJECT_NO_ACCESSIBILITY));
        assert_eq!(switch_calls(), 0, "no foreground taken, no pasteboard touched");
    }
    // 🔴 …but a MALFORMED payload must still be named as a malformed payload, even
    // with the gate shut. The frame-level verdict is platform-independent and
    // cheaper, so it is decided first; answering 「no Accessibility permission」 for
    // a picture that was never valid would send the user to System Settings to fix
    // something that is not broken.
    let _g = with_test_facts(SyntheticInputFacts {
        accessibility_trusted: false,
        secure_event_input: false,
    });
    let bad = inject_image("not base64!!", "image/png", Some(0x1234), switch_ok);
    assert_eq!(bad.error_code, Some(error_codes::INJECT_IMAGE_UNSUPPORTED));
}

#[test]
fn the_image_path_is_deliberately_untouched_by_the_self_window_ruling() {
    // owner's ruling is about 「我说的话」 ("the words I spoke"). FlowMic's own surfaces are plain text
    // fields with nowhere to receive a picture, so pasting one there would be an act
    // with no landing and `injected` would be a fabrication. The picture path
    // therefore keeps its 0.2.48 verdict verbatim — stated as an assertion so a
    // future 「conveniently filling this in while you're at it」 has to argue with it rather than slide past.
    let out = inject_image(PNG_B64, "image/png", None, switch_ok);
    assert_eq!(out.error_code, Some(error_codes::INJECT_FOCUS_LOST));
    assert_ne!(
        out.error_code,
        Some(error_codes::INJECT_SELF_WINDOW_NO_INPUT),
        "the picture path must not start answering with the text ruling's code"
    );
}

#[cfg(target_os = "windows")]
#[test]
// ── The one contract that CANNOT be asserted headlessly ──────────────────────
// Reaching Stage 2 means a REAL `SendInput` into whatever window is focused on the
// machine running the suite — the same hazard that got the Stage-3 image test
// turned off by owner on 2026-07-30, and the same handling: `#[ignore]`, so the
// harness prints `N ignored` on every run and this stays VISIBLE rather than
// silently green.
//   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- --ignored
// What it proves that nothing else can: an `Editable` verdict really does carry the
// frame past Stage 1 and Stage 1b into the typer, with `injected` meaning exactly
// what it means everywhere else.
#[ignore = "reaches the REAL SendInput and types into the focused window. Run with -- --ignored."]
fn an_editable_self_window_verdict_reaches_the_typer() {
    let out = inject_text_with_probe(
        "flowmic-self-window-probe",
        None,
        None,
        switch_fail, // 🔴 Stage 1 is SKIPPED for our own window — a switcher that
        // refuses everything must not be able to produce a focus loss here.
        probe_not_input, // 🔴 …and neither may the CROSS-PROCESS gate veto it.
        self_editable,
    );
    assert_ne!(out.error_code, Some(error_codes::INJECT_FOCUS_LOST));
    assert_ne!(out.error_code, Some(error_codes::INJECT_NO_TEXT_TARGET));
    assert_ne!(out.mode, InjectMode::Cached);
}

#[test]
fn text_into_a_proven_non_input_focus_is_refused_by_name() {
    let out = inject_text_with_probe(
        "hello",
        Some(0x1234),
        None,
        switch_ok,
        probe_not_input,
        self_never_ours,
    );
    assert!(!out.ok, "nothing was typed, so nothing may be claimed");
    assert_eq!(out.error_code, Some(error_codes::INJECT_NO_TEXT_TARGET));
    assert_ne!(out.mode, InjectMode::Cached, "non-cached → server maps to failed");
}

// ⚠️ In-place correction 2026-08-07 (MAC-06): was `target_os = "windows"` only, for the same
// reason as the test above (no format table off Windows). macOS now has one, so the
// gate widens — the test stays `#[ignore]`d on BOTH, and on macOS the hazard is the
// same act under different names: the REAL pasteboard and a REAL ⌘V.
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
// ── DISABLED on owner's instruction, 2026-07-30 ──────────────────────────────
// This is the ONLY test in the suite that reaches Stage 3, and Stage 3 is
// `ClipboardFallbackClient::new().paste_image(...)` — the REAL clipboard and a
// REAL Ctrl+V. `Some(0x1234)` + `switch_ok` clears Stage 1, and the picture
// policy deliberately refuses nothing (v0.2.9), so the 2×2 sample PNG lands in
// whatever window the developer happens to have focused. Every `cargo test`
// run pasted a picture into the owner's input box; owner asked for it off.
//
// Kept, not deleted — owner: 「需要的时候再开起来」 ("turn it back on when it's needed"). Re-enable ALL ignored tests
// with:  cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- --ignored
// `#[ignore]` was chosen over an env-var early-return on purpose: the harness
// prints `N ignored` on every single run, so this stays VISIBLE. A test that
// silently returns green while doing nothing is the runtime form of a façade.
//
// The real fix is not to keep it ignored: seam the clipboard client in
// `inject_image_with_probe` the way the probe itself is seamed, so this contract
// can be asserted without touching the machine (registered as RV-53).
#[ignore = "reaches the REAL clipboard + REAL Ctrl+V; pastes the 2x2 sample into the focused window (owner 2026-07-30). Run with -- --ignored. Real fix = RV-53 (seam the clipboard client)."]
// `ATTEMPTED` IS SHOUTED ON PURPOSE — do not snake_case it (DOC-HYG, 2026-08-09).
// v0.2.9 INVERTED this assertion: the old one said an image into a proven
// non-input focus is REFUSED. The single word carries which side of that
// inversion the test pins, and it is the word a reader scanning `cargo test`
// output has to see. Lower-casing it makes the name read like the assertion it
// replaced. The lint is right in general and wrong here, so it is silenced at the
// narrowest scope that works rather than crate-wide — an accidentally camelCased
// name elsewhere must still go red.
#[allow(non_snake_case)]
fn an_image_into_a_proven_non_input_focus_is_still_ATTEMPTED() {
    // v0.2.9 — the inversion of the old assertion, and the reason is the
    // whole point: the text gate is about TYPED CHARACTERS, and a picture
    // pastes into far more than what accepts typing. Refusing here was a
    // false negative that cost the owner every send; the legacy line, which
    // has no such gate, pastes fine.
    let out = inject_image_with_probe(
        PNG_B64,
        "image/png",
        Some(0x1234),
        switch_ok,
        probe_not_input,
    );
    assert_ne!(
        out.error_code,
        Some(error_codes::INJECT_NO_TEXT_TARGET),
        "a picture must not be refused by the TEXT gate"
    );
}

#[test]
fn the_text_refusal_policy_and_the_image_one_are_deliberately_different() {
    use crate::inject::target_probe::{image_refusal_for, refusal_for, FocusInputState};
    // Text: a proven non-input focus is a real refusal (stray characters there
    // fire the app's single-key accelerators).
    assert_eq!(
        refusal_for(FocusInputState::NotInput),
        Some(error_codes::INJECT_NO_TEXT_TARGET)
    );
    // Picture: it is not — a stray Ctrl+V is not an accelerator storm.
    assert_eq!(image_refusal_for(FocusInputState::NotInput), None);
    // Neither refuses a positive, and — the load-bearing half — neither refuses
    // on Unknown, which after 2026-07-30 is the OVERWHELMINGLY common answer for
    // any target outside our own process.
    for s in [FocusInputState::Input, FocusInputState::Unknown] {
        assert_eq!(refusal_for(s), None);
        assert_eq!(image_refusal_for(s), None);
    }
}

#[test]
fn a_malformed_image_is_still_rejected_before_the_probe_ever_runs() {
    // Ordering proof: an input-state focus would pass Stage 1b, so a decode
    // rejection here means the payload guard still comes first — a bad frame
    // must not reach the foreground or the probe.
    let out = inject_image_with_probe(
        "not base64 at all",
        "image/png",
        Some(0x1234),
        switch_ok,
        probe_input,
    );
    assert_eq!(out.error_code, Some(error_codes::INJECT_IMAGE_UNSUPPORTED));
}

#[test]
fn an_inconclusive_probe_does_not_block_either_path() {
    // Unknown ⇒ proceed. This is THE regression guard for the 0.2.19 P0: a probe
    // that cannot answer must not become a new way to lose an utterance, and
    // after the IMM measurement (target_probe.rs) Unknown is the normal answer for
    // every real target, so a refusal here would refuse everything.
    let text = inject_text_with_probe("hi", None, None, switch_ok, probe_unknown, self_never_ours);
    assert_eq!(text.error_code, Some(error_codes::INJECT_FOCUS_LOST));
    let img = inject_image_with_probe(PNG_B64, "image/png", None, switch_ok, probe_unknown);
    assert_ne!(img.error_code, Some(error_codes::INJECT_NO_TEXT_TARGET));
}

#[test]
fn an_over_cap_image_is_rejected_and_says_so() {
    let huge = "A".repeat(image::INJECT_IMAGE_B64_MAX + 4);
    let out = inject_image(&huge, "image/png", Some(0x1234), switch_ok);
    assert!(!out.ok);
    assert_eq!(out.error_code, Some(error_codes::INJECT_IMAGE_UNSUPPORTED));
    assert!(
        out.error_message.as_deref().unwrap().contains("exceeds cap"),
        "the over-cap reason is stated, not collapsed into a generic failure"
    );
}

// A VALID image with no target must be CACHED, exactly like text — the
// clipboard is never touched when there is nowhere to paste into.
//
// ⚠️ In-place correction 2026-08-07 (MAC-06): the gate used to be `target_os = "windows"`
// alone, because `clipboard_formats` needed WIC to produce a table at all and this
// test would otherwise have failed with INJECT_IMAGE_UNSUPPORTED on every other
// host. macOS now produces a table, so the test RUNS there — and it must, because
// this is the assertion that keeps a picture with no target from becoming a
// `failed` the phone offers to re-deliver. Hosts with no image path at all are
// still excluded, for the original reason.
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
fn a_valid_image_with_no_target_is_cached_not_failed() {
    let out = inject_image(PNG_B64, "image/png", None, switch_ok);
    assert!(!out.ok);
    assert_eq!(out.mode, InjectMode::Cached);
    assert_eq!(out.error_code, Some(error_codes::INJECT_FOCUS_LOST));

    let refused = inject_image(PNG_B64, "image/png", Some(0x1234), switch_fail);
    assert_eq!(refused.mode, InjectMode::Cached);
    assert_eq!(refused.error_code, Some(error_codes::INJECT_FOCUS_LOST));
}

// The image-outcome cluster (owner de-gating + F-4 dropped-unrendered) lives in
// pipeline_image_tests.rs since the F-4 additions put this file over the 800 cap;
// it is a child module so `use super::*` keeps every fake reachable.
#[path = "pipeline_image_tests.rs"]
mod image_tests;


// ── 🔴 L8 · a deferred-redelivery message must not auto-inject (owner 2026-08-02) ─────────────────────────
//
// docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md. The GATE is
// a pure function here; the fact that `run_inject` consults it BEFORE resolving a
// target (and therefore before any Win32) is asserted in socket/inject_ops.rs's own
// tests, where the composition lives.

#[test]
fn a_live_delivery_is_not_gated_at_all() {
    // 🔴 THE POSITIVE CONTROL for every zero below. If this ever returns `Some`,
    // the feature has become 「一刀切全拦」 ("a blanket block across the board") — every utterance would stop reaching the
    // user's window, and the negative assertions would still read green.
    assert_eq!(deferred_outcome(InjectOrigin::Live), None);
    // And the default (an ABSENT field — a pre-0.2.48 phone, or a relay that
    // stripped the key in flight) takes the same branch, by construction rather
    // than by a second literal.
    assert_eq!(deferred_outcome(InjectOrigin::default()), None);
    assert_eq!(InjectOrigin::from_wire(None), InjectOrigin::Live);
    assert_eq!(InjectOrigin::from_wire(Some("live")), InjectOrigin::Live);
    // A junk token is not a third policy. Only the exact word refuses.
    assert_eq!(InjectOrigin::from_wire(Some("DEFERRED")), InjectOrigin::Live);
    assert_eq!(InjectOrigin::from_wire(Some("")), InjectOrigin::Live);
}

#[test]
fn a_deferred_delivery_is_cached_with_its_own_named_reason() {
    assert_eq!(InjectOrigin::from_wire(Some("deferred")), InjectOrigin::Deferred);
    let out = deferred_outcome(InjectOrigin::Deferred).expect("a 补投 must be gated");
    assert!(!out.ok, "nothing was typed, so nothing may claim it was");
    // `Cached`, never a failure mode: the relay maps ok=false + cached to status
    // `cached`, which is the truth — the message is on this PC and can be injected
    // later from its row. A failure mode would tell the user it was lost.
    assert_eq!(out.mode, InjectMode::Cached);
    assert_eq!(
        out.error_code,
        Some(error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED),
        "没有静默失败: a deliberate non-injection still has to say which rule it was"
    );
    assert!(out.error_message.is_some());
}

#[test]
fn the_two_causes_of_cached_are_told_apart_by_their_code() {
    // 🔴 doc 15: `cached` now has TWO causes and they mean opposite things to the
    // user — 「点进输入框就能落地」 ("click into the input box and it'll land") vs
    // 「对窗口做什么都没用，去时间线上重新注入」 ("nothing you do to the window helps
    // — go re-inject from the timeline"). They
    // share `mode` (both are re-injectable) and MUST NOT share the code, or one
    // status word answers two questions — this repo's #1 bug shape.
    let no_focus = inject_text("hello", None, None, switch_ok);
    let deferred = deferred_outcome(InjectOrigin::Deferred).unwrap();
    assert_eq!(no_focus.mode, deferred.mode, "both are cached — that part IS shared");
    assert_ne!(
        no_focus.error_code, deferred.error_code,
        "two causes of one status must be distinguishable, or the UI cannot show them apart"
    );
    assert_eq!(no_focus.error_code, Some(error_codes::INJECT_FOCUS_LOST));
}

#[test]
fn the_forensic_token_keeps_absent_and_live_apart() {
    // ⚠️ The ONE thing that makes a stale-relay deploy diagnosable after the event.
    // 「手机说了 live」 ("the phone said live") and 「路上被剥掉了」 ("it was
    // stripped off en route") produce the SAME decision and must not
    // produce the same log line, or 「补投为什么还是注进去了」 ("why did a deferred
    // redelivery still get injected") has no evidence either
    // way. (Same lesson as RV-75's `Stated`.)
    let stated_live = InjectOrigin::tag(true, InjectOrigin::Live);
    let absent = InjectOrigin::tag(false, InjectOrigin::Live);
    assert_ne!(stated_live, absent);
    assert!(absent.contains("absent"), "the absent token must SAY absent: {absent}");
    assert_eq!(InjectOrigin::tag(true, InjectOrigin::Deferred), "deferred");
}
