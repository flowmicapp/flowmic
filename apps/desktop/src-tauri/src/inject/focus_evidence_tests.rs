// IJ-01 — does the PIPELINE actually carry the Stage-1b reading out, and does it
// carry the right one? (owner 2026-08-07 ruling ④; spec §A-4/§A-5/§A-6.)
//
// Declared from `inject/mod.rs` rather than from `pipeline.rs`, which is at the
// 800-line src cap. The tests belong to the pipeline all the same; the module
// declaration is a file-boundary detail, not a statement about ownership.
//
// 🔴 WHAT THIS FILE CAN AND CANNOT MEASURE, stated up front because the honest
// answer is「not all of it」and this repo reports "not measured" rather than "passed":
//
//   · `not_editable` — MEASURED end to end, on BOTH of its producers: the
//     cross-process Stage-1b `NotInput` refusal, and the in-process self-window
//     verdict. Both refuse, so both are produced without touching the keyboard.
//   · `unknown` / `editable` — NOT measured at this level, and that is a property
//     of the code under test rather than of the test. Both PROCEED, and proceeding
//     means `run_sendinput` → `SendInputClient::new()` → the real Win32 SendInput,
//     which would type into whatever window the developer has in front (the exact
//     hazard `an_image_into_a_proven_non_input_focus_is_still_ATTEMPTED` was
//     `#[ignore]`d for on owner's instruction, and the exact hazard CLAUDE.md's M5
//     tooling discipline exists for). The seam that would fix it is already
//     registered as RV-53 ("seam the clipboard client the way the probe is
//     seamed") and it is not this card's to build.
//     ⇒ Both values ARE covered one level down — `target_probe::wire_evidence`
//     (pure mapping, exhaustive) and `socket::wire_tests` (frame shape, all three
//     tokens) — so what is unmeasured is precisely 「whether the pipeline carries
//     it out」 on
//     those two branches, and nothing else.
//
// 🔴 AND THE PRODUCT FACT BEHIND `editable`. This paragraph used to say: 「with MSAA
// unwired, the ONLY situation a real user reaches the strong tier in is speaking into
// FlowMic's own window. Every third-party app answers `unknown`.」 Kept verbatim
// because it is evidence, not because it is true — its second sentence is the one
// the task book §1-bis-15 caught (a third-party window answers `not_editable` whenever
// Stage 1b proves it), and its first is now out of date as well: IJ-05 wired
// `inject::msaa_focus`, so a third-party window can reach the strong tier.
//
// ⚠️ AND THAT IS NOW THE SHIPPING DEFAULT, not a wired-but-dark path. `bc9ca65`
// flipped the probe ON by default (`msaa_focus::probe_enabled` — unset ⇒ enabled;
// the operator opt-out is `FLOWMIC_MSAA_FOCUS_PROBE=0`/`false`). Written down
// because 「wired」 and 「reached on an ordinary user's machine」 are two different
// claims, and the first one read alone leaves the second unasked. What the flip
// cannot do is widen refusals: [`MsaaVerdict`] is only `Editable` (an `upgrade`)
// or `Inconclusive` (the identity), so every non-editable read folds to the same
// `focus_evidence` a probe-off build carries — which is also why the paragraph
// below still holds unchanged. Residual, owner-accepted and NOT a claim this file
// measures: a default Chrome with renderer a11y asleep still answers `unknown`.
//
// 🔴 WHAT THAT MEANS FOR THIS FILE, and it is the load-bearing part: the strong tier
// is no longer reachable only through a branch these tests can drive. `editable` for
// a third-party window is produced by `msaa_focus::upgrade` on the REPORT binding —
// covered exhaustively one level down (every (base, verdict) pair, including the
// assertion that no pair can reach the one refusable state) — and still NOT covered
// here, for the same unchanged reason stated above: that branch PROCEEDS, and
// proceeding means a real SendInput into whatever window is in front.
//
// 🔴 AND THE RED LINE THE WHOLE CARD RESTS ON (§A-5): NO VERDICT MOVED. The last
// test here re-states 「cannot be determined ⇒ unknown ⇒ inject as usual」 from the composition's side,
// beside the `refusal_for` unit assertions in target_probe.rs.

use crate::error_codes;
use crate::inject::pipeline::inject_text_with_probe;
use crate::inject::self_focus::SelfFocusVerdict;
use crate::inject::target_probe::FocusInputState;

fn switch_ok(_h: u64) -> bool {
    true
}
fn probe_not_input() -> FocusInputState {
    FocusInputState::NotInput
}
fn probe_input() -> FocusInputState {
    FocusInputState::Input
}
fn probe_unknown() -> FocusInputState {
    FocusInputState::Unknown
}
fn self_never_ours() -> SelfFocusVerdict {
    SelfFocusVerdict::NotOurWindow
}
fn self_no_input() -> SelfFocusVerdict {
    SelfFocusVerdict::OwnWindowNoInput(crate::inject::self_focus::NoInputEvidence::Reported)
}

/// The one value reachable without a keystroke, and it is reported VERBATIM —
/// the same reading the refusal was made from, not a re-derivation.
#[test]
fn a_refused_frame_carries_the_very_reading_that_refused_it() {
    let out = inject_text_with_probe(
        "hello",
        Some(0x1234),
        None,
        switch_ok,
        probe_not_input,
        self_never_ours,
    );
    assert_eq!(out.error_code, Some(error_codes::INJECT_NO_TEXT_TARGET));
    assert_eq!(
        out.focus_evidence,
        Some(FocusInputState::NotInput),
        "the outcome must carry the Stage-1b reading, not drop it on the floor"
    );
}

/// 🔴 THE SECOND PRODUCER OF `not_editable`, and the one that took two arguments
/// to get right (see the note at `preflight::self_window_no_input`).
///
/// FlowMic's own window is in front and nothing editable holds DOM focus. That
/// path returns at Stage 0 and never reaches Stage 1b — so an implementation that
/// defined this field as 「Stage 1b's enum」 would report NOTHING here, and would be
/// silently dropping the strongest reading this codebase can produce. The field is
/// defined by its QUESTION (「is there positive evidence」), so it reports.
///
/// ⚠️ The pairing is the point: this is the same instrument whose positive half
/// becomes `editable`. Reporting one direction and dropping the other is a
/// measurement with a hole in it.
#[test]
fn our_own_window_with_no_editable_focus_reports_not_editable() {
    let out = inject_text_with_probe(
        "hi",
        None, // no lock ⇒ Stage 0 owns the frame (self_window_stage0's condition)
        None,
        switch_ok,
        // 🔴 The CROSS-PROCESS probe is handed the OPPOSITE reading on purpose: if
        // the outcome carried `Input` it would prove Stage 1b had leaked into a
        // branch that returns before it, and the test would fail loudly instead of
        // agreeing with itself.
        probe_input,
        self_no_input,
    );
    assert_eq!(out.error_code, Some(error_codes::INJECT_SELF_WINDOW_NO_INPUT));
    assert_eq!(out.focus_evidence, Some(FocusInputState::NotInput));
}

/// 🔴 §A-4 — absence ≠ `unknown`, asserted on the paths that really never ask.
///
/// Each row below returns BEFORE Stage 1b, and each one is a different reason:
/// an empty utterance, the length cap, and a Stage-1 focus loss. All three must
/// leave `focus_evidence` at `None`, because `Some(Unknown)` would mean 「we asked,
/// and could not get an answer」 — a measurement nobody made.
///
/// ⚠️ Note the probes handed in are the CONCLUSIVE ones: if any of these branches
/// leaked through to Stage 1b, the assertion would see `Some(..)` and fail. A test
/// that passed `probe_unknown` here would be green either way.
#[test]
fn a_path_that_never_probed_reports_nothing_rather_than_unknown() {
    // Empty text — short-circuits before the gate is even locked.
    let empty = inject_text_with_probe("", None, None, switch_ok, probe_input, self_never_ours);
    assert!(empty.ok);
    assert_eq!(empty.focus_evidence, None, "an empty utterance asked nothing");

    // Over the hard length cap — refused on the FRAME, before any window is read.
    let huge = "x".repeat(crate::inject::INJECT_TEXT_MAX_CHARS + 1);
    let capped = inject_text_with_probe(
        &huge,
        Some(0x1234),
        None,
        switch_ok,
        probe_input,
        self_never_ours,
    );
    assert_eq!(capped.error_code, Some(error_codes::INJECT_TARGET_INVALID));
    assert_eq!(capped.focus_evidence, None);

    // Stage 1 lost the focus — the probe is downstream of it.
    let lost = inject_text_with_probe("hi", None, None, switch_ok, probe_input, self_never_ours);
    assert_eq!(lost.error_code, Some(error_codes::INJECT_FOCUS_LOST));
    assert_eq!(lost.focus_evidence, None);

    // POSITIVE CONTROL — the same function, one branch further on, DOES report.
    // Without this the three assertions above would also hold for a build that
    // never fills the field at all, which is the state this card came to fix.
    let refused = inject_text_with_probe(
        "hi",
        Some(0x1234),
        None,
        switch_ok,
        probe_not_input,
        self_never_ours,
    );
    assert_eq!(refused.focus_evidence, Some(FocusInputState::NotInput));
}

/// 🔴 §A-5 — THE RED LINE, from the composition's side.
///
/// This card is allowed to report a reading and forbidden to act on one. The
/// regression it guards is the 0.2.19 P0 in one sentence: 「when it can't be
/// determined, refuse」 refuses
/// every browser dictation, because from outside the process a browser with an
/// input focused is byte-identical to one with nothing focused.
///
/// ⚠️ Asserted through the FOCUS-LOST path (`locked_hwnd: None`) rather than by
/// letting an `Unknown` reading proceed, because proceeding means a real
/// SendInput — see this file's header. What it therefore pins is the half that
/// can be pinned here: an inconclusive reading produces no refusal OF ITS OWN.
/// The pure half lives in `target_probe.rs`
/// (`an_inconclusive_reading_must_not_break_injection`), and that is the test the
/// reverse control drives red.
#[test]
fn an_inconclusive_reading_still_produces_no_refusal_of_its_own() {
    let out = inject_text_with_probe("hi", None, None, switch_ok, probe_unknown, self_never_ours);
    assert_eq!(
        out.error_code,
        Some(error_codes::INJECT_FOCUS_LOST),
        "the ONLY refusal here may be Stage 1's; an Unknown reading must add none"
    );
    assert_ne!(
        out.error_code,
        Some(error_codes::INJECT_NO_TEXT_TARGET),
        "「when it can't be determined, refuse」 is the 0.2.19 P0 — it refuses every browser dictation"
    );
}
