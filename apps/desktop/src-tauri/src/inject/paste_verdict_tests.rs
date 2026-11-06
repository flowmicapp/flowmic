// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §0 「2026-11-05 注入段补充」
//     and its §3.2 row (the rule these tests pin)
//   docs/marketing/05b-defects-found.md D-MKT-8 (the measurement behind it)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// D-MKT-8: on a Windows 10 test PC, a text paste into Notepad that nobody
// fetched (`render-receipt=none … read-back=not-observed`) was reported
// `injected`, and the PC row read 「Injected (input confirmed)」 over an empty
// window — 3/3 deliberate clipboard races and 2 of 89 ordinary sends. These
// tests pin the verdict that replaced it and the one dispatch rule that keeps
// that verdict from being typed over.

use super::*;
use crate::inject::text_route::PasteReason;

/// The reading from the defect, field for field: nobody fetched our format,
/// the element was readable and did not end with our text, held 1502 ms.
fn unfetched(landing: LandingEvidence) -> PasteOutcome {
    PasteOutcome {
        confirmed: false,
        landing,
        held_ms: 1502,
    }
}

fn typed_ok() -> InjectOutcome {
    InjectOutcome {
        ok: true,
        mode: InjectMode::SendInput,
        error_code: None,
        error_message: None,
        focus_evidence: None,
    }
}

/// Ties the platform constant to the platform's own forensic sentence instead
/// of to a second `cfg`: the verdict may read `confirmed == false` as a
/// measurement exactly where the log line says we watched for a fetch.
#[test]
fn the_receipt_is_a_measurement_exactly_where_the_log_says_it_watched() {
    assert_eq!(
        RECEIPT_IS_OBSERVED,
        receipt_phrase(false).contains("nobody fetched"),
        "RECEIPT_IS_OBSERVED disagrees with this platform's own receipt sentence"
    );
}

/// The defect itself. Both non-confirming read-back values, because the rule
/// rests on the receipt alone: read-back may only ever say yes.
#[test]
fn an_unfetched_paste_is_failed_not_injected() {
    for landing in [LandingEvidence::NotObserved, LandingEvidence::Unavailable] {
        let out = map_routed_paste_on(Ok(unfetched(landing)), PasteReason::DefaultPath, true);
        assert!(
            !out.ok,
            "nobody fetched our text, so none of it can be in the target ({landing:?})"
        );
        assert_eq!(
            out.mode,
            InjectMode::Clipboard,
            "the Ctrl+V did go out: this is not `cached` (keyboard never touched)"
        );
        assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
    }
}

/// Positive evidence outranks the missing receipt: a text read-back SAW means
/// the receipt instrument was blind, and the delivery stands.
#[test]
fn a_seen_landing_overrules_a_missing_receipt() {
    let out = map_routed_paste_on(
        Ok(unfetched(LandingEvidence::Confirmed)),
        PasteReason::DefaultPath,
        true,
    );
    assert!(out.ok);
    assert_eq!(out.error_code, None);
}

/// The other direction is unchanged: a served receipt is not landing evidence
/// (2026-08-22), and it is not a negative either, so the verdict stays.
#[test]
fn a_served_receipt_keeps_the_verdict_it_had() {
    let served = PasteOutcome {
        confirmed: true,
        landing: LandingEvidence::NotObserved,
        held_ms: 1500,
    };
    let out = map_routed_paste_on(Ok(served), PasteReason::DefaultPath, true);
    assert!(out.ok);
    assert_eq!(out.error_code, None);
}

/// macOS / Linux: `confirmed` is false by construction there and says nothing.
#[test]
fn without_a_receipt_instrument_nothing_changes() {
    let out = map_routed_paste_on(
        Ok(unfetched(LandingEvidence::Unavailable)),
        PasteReason::DefaultPath,
        false,
    );
    assert!(out.ok, "a platform with no receipt keeps the verdict it had");
}

/// Every combination, so a later edit that moves one corner shows up here.
#[test]
fn the_whole_truth_table() {
    for observed in [false, true] {
        for confirmed in [false, true] {
            for landing in [
                LandingEvidence::Confirmed,
                LandingEvidence::NotObserved,
                LandingEvidence::Unavailable,
            ] {
                let paste = PasteOutcome {
                    confirmed,
                    landing,
                    held_ms: 0,
                };
                let out = map_routed_paste_on(Ok(paste), PasteReason::DefaultPath, observed);
                let refused = observed && !confirmed && landing != LandingEvidence::Confirmed;
                assert_eq!(
                    out.ok, !refused,
                    "observed={observed} confirmed={confirmed} landing={landing:?}"
                );
            }
        }
    }
}

/// The console route's clipboard fallback (`map_clipboard_outcome`) follows
/// the same rule, read off this host's constant.
#[test]
fn the_console_fallback_paste_follows_the_same_rule_on_this_host() {
    let store = AppLearningStore::new();
    let out = map_clipboard_outcome(Ok(unfetched(LandingEvidence::NotObserved)), None, &store);
    assert_eq!(out.ok, !RECEIPT_IS_OBSERVED);
    if !out.ok {
        assert_eq!(out.mode, InjectMode::Clipboard);
        assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
    }
}

/// The dispatch half. An unfetched paste's Ctrl+V is already in the target, so
/// typing after it would be a second, unverifiable action whose success would
/// put a claim without evidence back on the row.
#[test]
fn an_unfetched_paste_is_never_typed_after() {
    let store = AppLearningStore::new();
    let typed = std::cell::Cell::new(false);
    let out = crate::inject::text_dispatch::type_or_paste_routed(
        "Plain English into an ordinary editor.",
        Some("notepad"),
        // D-MKT-5 flag on, as production passes it on Windows; notepad is not a
        // console, so nothing is flattened either way.
        true,
        &store,
        &|_t, _id, _s| {
            typed.set(true);
            typed_ok()
        },
        &|_t, _id, _s| panic!("the console fallback is not on this route"),
        &|_t, reason| {
            let result = Ok(unfetched(LandingEvidence::NotObserved));
            let act_completed = result.is_ok();
            (map_routed_paste_on(result, reason, true), act_completed)
        },
    );
    assert!(!typed.get(), "typing ran after a paste whose Ctrl+V already reached the target");
    assert!(!out.ok);
    assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
}

/// Positive control for the test above (a dispatcher that never types would
/// pass it): a paste whose ACT failed still falls back to typing, as before.
#[test]
fn a_paste_whose_act_failed_still_falls_back_to_typing() {
    let store = AppLearningStore::new();
    let typed = std::cell::Cell::new(false);
    let out = crate::inject::text_dispatch::type_or_paste_routed(
        "Plain English into an ordinary editor.",
        Some("notepad"),
        true,
        &store,
        &|_t, _id, _s| {
            typed.set(true);
            typed_ok()
        },
        &|_t, _id, _s| panic!("the console fallback is not on this route"),
        &|_t, reason| {
            let result: Result<PasteOutcome, InjectError> = Err(InjectError::Win32(5));
            let act_completed = result.is_ok();
            (map_routed_paste_on(result, reason, true), act_completed)
        },
    );
    assert!(typed.get(), "a paste that never ran must still fall back to typing");
    assert!(out.ok);
    assert_eq!(out.mode, InjectMode::SendInput);
}
