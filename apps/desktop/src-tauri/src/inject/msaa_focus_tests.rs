// IJ-05 unit tests, split out of `msaa_focus.rs` at the 800-line src cap — the same
// cut `focus_evidence_tests.rs` and `pipeline_tests.rs` already make.
//
// 🔴 NOTHING CHANGED IN THE MOVE except `use super::*` becoming an explicit path:
// every assertion below is the verbatim text that was in msaa_focus.rs, and any diff
// beyond 「the move」 would be a bug in this split rather than a change anyone asked for.
// (established repo convention: crossing the 800-line gate means a structural split, not deleting evidence.)

use crate::inject::msaa_focus::*;
use crate::inject::target_probe::FocusInputState;



fn answered(role: i32, state: i32) -> MsaaReading {
    MsaaReading {
        answered: true,
        depth: 2,
        role,
        state,
        name_equals_window_title: false,
        elapsed_ms: 3,
        note: "",
    }
}

/// The one positive, asserted against the RAW number rather than the constant's
/// name — the IJ-03 spike's whole role table was wrong and only this value
/// happening to be right saved its conclusions (its §5-3).
#[test]
fn the_only_editable_reading_is_an_enabled_writable_text_element() {
    assert_eq!(ROLE_SYSTEM_TEXT, 0x2A, "ROLE_SYSTEM_TEXT is 0x2A");
    assert_eq!(judge(&answered(0x2A, 0)), MsaaVerdict::Editable);
    // FOCUSED|FOCUSABLE alongside it changes nothing.
    assert_eq!(judge(&answered(0x2A, 0x4 | 0x100000)), MsaaVerdict::Editable);
}

/// 🔴 The READONLY bit is why MSAA was enough and IA2 was never needed. A
/// read-only text box is a TEXT role WITH a caret — the exact case that killed
/// the 「having an insertion caret means it's input-capable」 candidate.
#[test]
fn a_read_only_text_box_is_not_editable_however_much_it_looks_like_one() {
    assert_eq!(STATE_SYSTEM_READONLY, 0x40);
    assert_eq!(judge(&answered(0x2A, STATE_SYSTEM_READONLY)), MsaaVerdict::Inconclusive);
    assert_eq!(
        judge(&answered(0x2A, STATE_SYSTEM_UNAVAILABLE)),
        MsaaVerdict::Inconclusive,
        "a disabled field accepts nothing"
    );
}

/// 🔴 THE 0.2.19 GUARD, at this layer. 360极速浏览器X and WeChat hand back nothing
/// but the window shell — measured, 11 and 15 readings, every one. Both shell
/// shapes must be Inconclusive, because the alternative refuses owner's main
/// browser.
#[test]
fn a_window_shell_reading_is_never_a_positive_however_normal_it_looks() {
    // Shape 1: never descended. Note it is dressed as a plausible answer —
    // that is exactly how it arrives (CLIENT + FOCUSABLE + a name).
    let shell = MsaaReading {
        answered: true,
        depth: 0,
        role: 0xA, // ROLE_SYSTEM_CLIENT
        state: 0x100000,
        name_equals_window_title: true,
        elapsed_ms: 2,
        note: "",
    };
    assert_eq!(judge(&shell), MsaaVerdict::Inconclusive);

    // Shape 2: descended, but answered with the window's own title. Role is
    // TEXT here on purpose — without the title test this would read Editable.
    let titled = MsaaReading {
        depth: 2,
        role: 0x2A,
        state: 0,
        name_equals_window_title: true,
        ..shell.clone()
    };
    assert_eq!(
        judge(&titled),
        MsaaVerdict::Inconclusive,
        "an element whose name IS the window title is the shell wearing a text role"
    );

    // Shape 3: depth 0 alone is disqualifying, even with a perfect role/state.
    let deep_zero = MsaaReading {
        depth: 0,
        role: 0x2A,
        state: 0,
        name_equals_window_title: false,
        ..shell.clone()
    };
    assert_eq!(judge(&deep_zero), MsaaVerdict::Inconclusive);
}

/// Every non-answer is Inconclusive, including the ones that carry junk in the
/// other fields — a reader must never have to check `answered` separately.
#[test]
fn every_way_of_not_answering_lands_on_inconclusive() {
    for note in [
        "not attempted",
        "no foreground window",
        "AccessibleObjectFromWindow failed",
        "budget exceeded — the foreground app did not answer in time",
        "panicked",
    ] {
        let r = MsaaReading {
            answered: false,
            depth: 3,
            role: 0x2A, // a perfect-looking role on an unanswered read
            state: 0,
            name_equals_window_title: false,
            elapsed_ms: 0,
            note,
        };
        assert_eq!(judge(&r), MsaaVerdict::Inconclusive, "note={note}");
    }
    assert_eq!(judge(&MsaaReading::default()), MsaaVerdict::Inconclusive);
}

/// A role we have never validated is not a negative — it is a non-answer. This
/// pins that the predicate is a WHITELIST: adding a role must be a deliberate
/// edit here, never a side effect of an app returning something new.
#[test]
fn an_unvalidated_role_is_inconclusive_rather_than_a_guess() {
    for role in [
        0x0A, // CLIENT
        0x0F, // DOCUMENT — chrome with nothing focused
        0x10, // PANE
        0x0C, // MENUITEM
        0x22, // LISTITEM
        0x29, // STATICTEXT — deliberately adjacent to TEXT
        0x2B, // PUSHBUTTON
        -1,   // the reader's own 「could not read the role」 sentinel
    ] {
        assert_eq!(judge(&answered(role, 0)), MsaaVerdict::Inconclusive, "role=0x{role:x}");
    }
}

/// 🔴🔴 THE RED LINE, EXHAUSTIVELY. Every (base, verdict) pair, so a future edit
/// that lets MSAA reach `NotInput` — the only value `refusal_for` refuses — has
/// to break a row here.
///
/// This is the assertion that makes 「an enhancement is not a gate」 a property of the code rather
/// than a sentence in a comment.
#[test]
fn msaa_can_only_ever_upgrade_unknown_and_never_produces_a_refusable_state() {
    // ⚠️ A HAND-WRITTEN ARRAY, named as a weakness rather than left as a nit
    // (adversarial review 2026-08-08): `upgrade`'s catch-all `(other, _) => other`
    // means a 4th `FocusInputState` variant would compile clean here and this test
    // would silently UNDER-COVER while still calling itself exhaustive. What
    // actually forces a 4th variant to be considered is
    // `target_probe::refusal_for`'s wildcard-free `match` — the guarantee lives in
    // ANOTHER FILE than the test that claims it (§1-bis-13). Add a row here in the
    // same commit as any new variant.
    let bases = [
        None,
        Some(FocusInputState::Input),
        Some(FocusInputState::NotInput),
        Some(FocusInputState::Unknown),
    ];
    for base in bases {
        for v in [MsaaVerdict::Editable, MsaaVerdict::Inconclusive] {
            let got = upgrade(base, v);

            // ① The ONLY movement allowed in the whole table.
            if base == Some(FocusInputState::Unknown) && v == MsaaVerdict::Editable {
                assert_eq!(got, Some(FocusInputState::Input));
            } else {
                assert_eq!(got, base, "base={base:?} verdict={v:?} must pass through");
            }

            // ② 🔴 MSAA may never MANUFACTURE the one refusable state.
            if got == Some(FocusInputState::NotInput) {
                assert_eq!(
                    base,
                    Some(FocusInputState::NotInput),
                    "NotInput came out of upgrade() without going in — that is 「when it can't be \
                     determined, refuse」, \
                     the 0.2.19 P0, which refuses owner's own browser"
                );
            }

            // ③ absence ≠ unknown, preserved through the fold (§A-4).
            if base.is_none() {
                assert!(got.is_none(), "a path that never probed must stay silent");
            }

            // ④ The refusal this frame would produce is UNCHANGED by MSAA.
            assert_eq!(
                crate::inject::target_probe::refusal_for(
                    got.unwrap_or(FocusInputState::Unknown)
                ),
                crate::inject::target_probe::refusal_for(
                    base.unwrap_or(FocusInputState::Unknown)
                ),
                "MSAA moved a verdict: base={base:?} verdict={v:?}"
            );
        }
    }
}

/// The seam's default must be inert, or this card silently rewrites the evidence
/// of every other test in the suite. (`preflight.rs` learned this the expensive
/// way — its gate moved 16 tests the first time it was wired.)
#[test]
fn the_test_seam_defaults_to_inconclusive_so_no_other_test_is_moved() {
    assert_eq!(msaa_verdict(), MsaaVerdict::Inconclusive);
    assert_eq!(
        upgrade(Some(FocusInputState::Unknown), msaa_verdict()),
        Some(FocusInputState::Unknown),
        "the default must leave a third-party reading exactly where it was"
    );
}

/// …and the guard must restore it even when the test that set it panicked,
/// because `cargo test` reuses threads.
#[test]
fn the_guard_restores_the_inert_default_on_drop() {
    {
        let _g = with_test_verdict(MsaaVerdict::Editable);
        assert_eq!(msaa_verdict(), MsaaVerdict::Editable);
    }
    assert_eq!(msaa_verdict(), MsaaVerdict::Inconclusive);
}

/// 🔴 The two hand-written ABI literals, checked against the crate's own
/// constants. Without this the module carries an unverified number-to-meaning
/// table — the precise thing that went wrong in the IJ-03 spike (§5-3), where
/// the whole role table was wrong and only luck kept the conclusions.
#[cfg(windows)]
#[test]
fn the_hand_written_variant_tags_match_the_crates_own_constants() {
    use windows::Win32::System::Variant::{VT_DISPATCH, VT_I4};
    assert_eq!(VT_I4_RAW, VT_I4.0, "VT_I4 is 3");
    assert_eq!(VT_DISPATCH_RAW, VT_DISPATCH.0, "VT_DISPATCH is 9");
}

/// 🔴 THE ONLY TEST THAT EXECUTES THE REAL COM WALK, and it is deliberately a
/// SMOKE test — read what it does not claim before relying on it.
///
/// The seam means every other test here drives `judge`/`upgrade` over data a
/// test wrote, so without this one `read_focus` would be proved by NOTHING but
/// the compiler. This calls the real thing.
///
/// 🔴 HOW FAR IT ACTUALLY GETS DEPENDS ON THE MACHINE, and saying otherwise
/// would be the exact defect this card spent its window correcting. On a box
/// with an activated window it goes all the way through
/// `AccessibleObjectFromWindow`, the `accFocus` walk and the VARIANT reads. On
/// the box this was written on it returned at `GetForegroundWindow()` —
/// measured: the test completes in ~0 ms there, because that session had
/// nothing activated. ⇒ On THAT machine this proves the thread, the budget,
/// the panic guard and the fold; it does NOT prove the COM walk. The reading is
/// printed by `one_line()` if you need to know which of the two you got.
///
/// ⚠️ EVERY ASSERTION BELOW MUST HOLD ON EVERY MACHINE, and that constraint is
/// the point rather than a limitation. A test that asserted 「it finds an
/// editable focus」 would pass or fail according to what the developer happened
/// to have in front — which is `preflight.rs`'s recorded disaster (its gate
/// moved 16 tests the first time it was wired) and this repo's second-named
/// headline shape (check your ruler first). So it asserts only properties that are true
/// with a live desktop, with a dead one, and on CI:
///   · it TERMINATES, and within its own budget;
///   · it does not panic — including inside the COM walk, whose unwind is
///     caught by `read_focus_bounded`;
///   · a non-answer is never a positive.
///
/// 🔴 WHAT IT THEREFORE DOES NOT PROVE: that the walk ever finds anything. On
/// the machine this card was written on it could not — that session had no
/// activated window at all — so 「MSAA positively identifies an editable focus,
/// in this Rust implementation, on a real foreground window」 is [unverified] and is
/// recorded as such (2026-08-08-ij-window-ledger.md §5-1). Do not read a green
/// here as that.
#[test]
fn the_real_reader_terminates_within_budget_and_never_answers_positively_by_accident() {
    let started = std::time::Instant::now();
    let r = read_focus_bounded();
    let elapsed = started.elapsed();

    assert!(
        elapsed < std::time::Duration::from_millis(MSAA_BUDGET_MS * 4 + 2000),
        "the reader must be bounded — it sits under the inject gate between \
         「finished speaking」 and 「text lands on screen」; took {elapsed:?}"
    );
    // Whatever it saw, the fold must be one of the two verdicts and must be
    // incapable of manufacturing a refusal from it.
    let v = judge(&r);
    assert_eq!(
        upgrade(Some(FocusInputState::NotInput), v),
        Some(FocusInputState::NotInput),
        "a real reading must never overturn a Stage-1b proof"
    );
    assert_eq!(upgrade(None, v), None, "a real reading must never fill in absence");
    if !r.answered {
        assert_eq!(
            v,
            MsaaVerdict::Inconclusive,
            "a walk that did not answer must never be a positive: {}",
            r.one_line()
        );
    }
    // 🔴 ADDED after adversarial review, which proved the gap: with `read_focus`
    // replaced by an unconditional `panic!`, every assertion above still passed —
    // `catch_unwind` folds a panic into `answered:false, note:"panicked"`, which
    // satisfies all of them. A test that stays green when the function under test
    // cannot run AT ALL is the substitute-criterion shape (§1-bis-10), and it was
    // sitting in the one test whose entire purpose is to execute that function.
    assert_ne!(
        r.note, "panicked",
        "the real reader panicked. catch_unwind contained it — this test exists to \
         NOTICE that, not to be soothed by it"
    );
}

/// The forensic line must carry the RAW numbers, not just the conclusion — the
/// 2026-07-30 rule that this whole evidence line came out of.
#[test]
fn the_forensic_line_prints_the_numbers_a_diagnosis_would_need() {
    let line = answered(0x2A, 0x44).one_line();
    assert!(line.contains("role=0x2a"), "{line}");
    assert!(line.contains("state=0x44"), "{line}");
    assert!(line.contains("d=2"), "{line}");
    assert!(line.contains("shellName=false"), "{line}");
    // A non-answer must say WHY, or the log cannot distinguish 「could not be asked」 from
    // 「genuinely isn't there」 — the same distinction `gui_ok` exists for.
    assert!(MsaaReading::default().one_line().contains("not attempted"));
}

// ── the IJ-03b gate (ships OPEN since IJ-05, 2026-08-09) ──────────────────────
//
// IJ-05 landed behind an adopted precondition (IJ-03b ① must close the
// Medium→Medium hole first) and shipped OFF. That precondition was MEASURED on
// 2026-08-09 (Medium→Medium reads the real editable element, not a shell —
// [measured · dev-pc-b]) and the owner ruled the default flips ON. These pin
// the gate by BEHAVIOUR — whether the reader runs — because the failure this
// guards against is a default that quietly flips, and a source grep cannot see
// that. The guarded direction REVERSED with the ruling: the bug is now a default
// that quietly flips back OFF (silently skipping the probe everywhere), or an
// operator opt-out that fails to opt out.

#[test]
fn the_gate_ships_open_and_only_an_explicit_off_closes_it() {
    // The default — what a user's build sees when nobody set anything.
    assert!(probe_enabled(None), "the probe ships ON since IJ-03b ① was measured (IJ-05, 2026-08-09)");
    // The operator opt-out must actually opt out.
    assert!(!probe_enabled(Some("0")));
    assert!(!probe_enabled(Some("false")));
    // Anything not recognisably "off" stays on: the failure direction is inert
    // (Inconclusive = 0.2.58-identical behaviour), so a typo'd value should probe,
    // not silently skip.
    assert!(probe_enabled(Some("1")));
    assert!(probe_enabled(Some("")));
    assert!(probe_enabled(Some("true")));
    assert!(probe_enabled(Some("yes")));
}

#[test]
fn a_closed_gate_never_reaches_the_reader_at_all() {
    // Not "returns Inconclusive" — that is also what a reader that ran and found
    // nothing returns, and those two must stay distinguishable. The reader is a
    // blocking cross-process COM call under the inject gate; the point of OFF is
    // that it is never paid for.
    let v = verdict_with(false, || panic!("the reader ran with the gate CLOSED"));
    assert_eq!(v, MsaaVerdict::Inconclusive);
}

#[test]
fn an_open_gate_does_reach_the_reader_and_its_verdict_is_the_judge() {
    // Positive control for the test above: without this, deleting the call to
    // `read()` entirely would leave `a_closed_gate_...` green.
    let v = verdict_with(true, || answered(ROLE_SYSTEM_TEXT, 0));
    assert_eq!(v, MsaaVerdict::Editable, "an open gate must use the reader's answer");
    let v = verdict_with(true, || answered(ROLE_SYSTEM_TEXT, STATE_SYSTEM_READONLY));
    assert_eq!(v, MsaaVerdict::Inconclusive, "and must still run it through `judge`");
}
