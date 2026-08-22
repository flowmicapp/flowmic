// SPEC-REF:
//   docs/strategy/2026-08-22-clipboard-restore-race-findings.md (the P0 this rule
//     is the fix for, with the measurements)
//   master-plan §4 / CLAUDE.md red line R11: a status word must be able to answer
//     "on what grounds do you say that"
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// ONE RULE: while a clipboard paste is in flight, may we hand the user's own
// clipboard back yet?
//
// It is a file of its own — split out of `clipboard_confirm.rs` at the 800-line
// cap, and the cut is deliberate rather than arithmetic. "Should we still be
// holding this?" and "the OS is asking us for the bytes" (clipboard_render_slot.rs)
// are two different questions, and 2026-08-22 happened because one answer was
// being used for both.

/// Everything the hold loop is allowed to decide on.
///
/// ⚠️ `dead_code` on non-Windows is EXPECTED and true: only the Win32 paste loop
/// consumes this rule today (macOS spends a fixed sleep instead — see
/// `macos/pasteboard.rs`). It is allowed rather than `cfg`-ed away so the rule and
/// its drill stay COMPILED AND TESTED on every host — a pure rule that only exists
/// on the platform that already got it wrong is worth much less.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HoldInputs {
    /// Somebody fetched one of our formats. 🔴 PRESENT SO THAT IT CAN BE SEEN
    /// NOT TO DECIDE ANYTHING — see [`hold_decision`].
    pub receipt_served: bool,
    /// Read-back saw our text arrive in the focused element.
    pub landing_confirmed: bool,
    /// The hold window is up.
    pub expired: bool,
    /// `send_ctrl_v` itself failed; there is nothing to hold for.
    pub paste_failed: bool,
}

/// Should the paste keep holding the payload on the clipboard? `None` = keep
/// holding; `Some(reason)` = stop, and the reason goes on the forensic line.
///
/// ── THIS FUNCTION IS THE P0, ISOLATED SO IT CAN BE PINNED ────────────────────
/// The shipped loop was, in effect, `if receipt_served { stop }`. That is the
/// whole defect: the receipt arrives ~13ms after Ctrl+V regardless of whether the
/// target is in any state to paste, so stopping on it handed the user's clipboard
/// back while the target had not read anything yet, and a busy target then pasted
/// THE USER'S OLD TEXT while we reported `injected`.
///
/// `receipt_served` is still an input, deliberately: a rule can only be pinned
/// against a mistake that is expressible. `the_receipt_can_never_end_the_hold`
/// drives both values through every other combination and demands the same
/// answer, and that test goes RED against the old rule. It earns its keep in the
/// stop REASON too — "nobody ever fetched our format" and "somebody fetched it
/// but we never saw it land" send the next debugger to different places.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn hold_decision(i: HoldInputs) -> Option<&'static str> {
    if i.paste_failed {
        return Some("paste-error");
    }
    if i.landing_confirmed {
        return Some("landing-confirmed");
    }
    if i.expired {
        return Some(if i.receipt_served {
            "hold-expired (our format WAS fetched; the landing was never observed)"
        } else {
            "hold-expired (nobody ever fetched our format)"
        });
    }
    None
}

#[cfg(test)]
mod hold_rule_drill {
    //! THE DRILL FOR THE 2026-08-22 P0.
    //!
    //! The defect was one boolean in one loop condition, and no test in this repo
    //! could see it: the whole clipboard suite drives `Box<dyn Fn>` fakes that
    //! return whatever receipt they are told to, so "the loop stops on the
    //! receipt" was never a claim anything checked. `hold_decision` exists to make
    //! that claim checkable.
    //!
    //! 🔴 SEEN RED BEFORE GREEN. Restoring the shipped rule — an early
    //! `if i.receipt_served { return Some("receipt"); }` at the top of
    //! `hold_decision` — fails `the_receipt_can_never_end_the_hold` with
    //! `left: Some("receipt") right: None` on the first row it reaches, and
    //! nothing else in the suite moves. Reverted, re-run, green.
    use super::{hold_decision, HoldInputs};

    fn inputs() -> HoldInputs {
        HoldInputs {
            receipt_served: false,
            landing_confirmed: false,
            expired: false,
            paste_failed: false,
        }
    }

    /// 🔴 THE ONE THAT WOULD HAVE CAUGHT IT. The receipt may move the REASON but
    /// never the decision: with everything else held fixed, both values of
    /// `receipt_served` must give the same verdict about whether to keep holding.
    #[test]
    fn the_receipt_can_never_end_the_hold() {
        for landing_confirmed in [false, true] {
            for expired in [false, true] {
                for paste_failed in [false, true] {
                    let base = HoldInputs {
                        landing_confirmed,
                        expired,
                        paste_failed,
                        receipt_served: false,
                    };
                    let served = HoldInputs {
                        receipt_served: true,
                        ..base
                    };
                    assert_eq!(
                        hold_decision(base).is_none(),
                        hold_decision(served).is_none(),
                        "the render receipt changed whether we keep holding, and it is not \
                         allowed to: {base:?}"
                    );
                }
            }
        }
    }

    /// The positive control for the test above: without it, a `hold_decision`
    /// that ALWAYS returns `None` would pass, and a paste that never lets go of
    /// the user's clipboard is its own P0.
    #[test]
    fn the_hold_does_end_for_the_three_reasons_that_may_end_it() {
        assert_eq!(
            hold_decision(HoldInputs {
                landing_confirmed: true,
                ..inputs()
            }),
            Some("landing-confirmed")
        );
        assert_eq!(
            hold_decision(HoldInputs {
                paste_failed: true,
                ..inputs()
            }),
            Some("paste-error")
        );
        assert!(hold_decision(HoldInputs {
            expired: true,
            ..inputs()
        })
        .is_some());
        assert_eq!(hold_decision(inputs()), None, "nothing happened yet: hold");
    }

    /// A confirmed landing outranks the clock: if the text is already in the box
    /// there is no reason to keep the user's clipboard hostage for the rest of
    /// the window. This is what makes the common case SHORTER than the behaviour
    /// that shipped, not longer.
    #[test]
    fn a_confirmed_landing_releases_the_clipboard_immediately() {
        assert_eq!(
            hold_decision(HoldInputs {
                landing_confirmed: true,
                receipt_served: true,
                expired: false,
                paste_failed: false,
            }),
            Some("landing-confirmed")
        );
    }

    /// The two expiry reasons must be distinguishable, because they send the next
    /// debugger to different places: "nobody fetched it" points at the keystroke
    /// or the focus, "fetched but never seen to land" points at read-back or at a
    /// target that is slower than the hold.
    #[test]
    fn the_two_expiry_reasons_are_not_the_same_sentence() {
        let quiet = hold_decision(HoldInputs {
            expired: true,
            ..inputs()
        });
        let fetched = hold_decision(HoldInputs {
            expired: true,
            receipt_served: true,
            ..inputs()
        });
        assert_ne!(quiet, fetched);
    }
}

